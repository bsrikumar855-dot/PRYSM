import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canonicalJson, compilePolicy, evaluate, parsePolicyYaml, type CompiledPolicy } from './index.ts';

const demoYaml = readFileSync(new URL('../../policies/demo-policy.yaml', import.meta.url), 'utf8');
const policy = parsePolicyYaml(demoYaml);
const call = (name: unknown, args?: unknown) => (args === undefined ? { name } : { name, arguments: args });

describe('the four decisions the demo needs', () => {
  it('allow: a read-only tool with a matching rule', () => {
    const d = evaluate(policy, call('lookup_order', { order_id: 'ORD-1001' }));
    expect(d).toMatchObject({
      decision: 'allow',
      reason: 'rule',
      rule_id: 'allow-lookup-order',
      source: 'demo-policy:DEMO-001',
    });
  });

  it('allow: a refund within the limit', () => {
    expect(evaluate(policy, call('refund_payment', { amount_inr: 1200 }))).toMatchObject({
      decision: 'allow',
      rule_id: 'allow-small-refund',
    });
    expect(evaluate(policy, call('refund_payment', { amount_inr: 5000 }))).toMatchObject({ decision: 'allow' });
  });

  it('deny: a tool the policy forbids', () => {
    const d = evaluate(policy, call('export_customer_data', { scope: 'all' }));
    expect(d).toMatchObject({
      decision: 'deny',
      reason: 'rule',
      rule_id: 'deny-customer-export',
      source: 'demo-policy:DEMO-004',
    });
  });

  it('require_approval: a refund above the limit', () => {
    const d = evaluate(policy, call('refund_payment', { amount_inr: 9000 }));
    expect(d).toMatchObject({ decision: 'require_approval', reason: 'rule', rule_id: 'approve-large-refund' });
  });

  it('unknown tool: default deny, and it says so', () => {
    const d = evaluate(policy, call('delete_database', { name: 'prod' }));
    expect(d).toMatchObject({
      decision: 'deny',
      reason: 'unknown-tool',
      tool: 'delete_database',
      rule_id: null,
      source: null,
    });
    expect(d.matched).toEqual([]);
  });
});

describe('default deny and untrusted input', () => {
  it('a known tool whose conditions match no rule is denied, not allowed', () => {
    const d = evaluate(policy, call('refund_payment', { currency: 'INR' })); // no amount at all
    expect(d).toMatchObject({ decision: 'deny', reason: 'no-matching-rule', tool: 'refund_payment' });
    expect(d.trace.map((t) => t.matched)).toEqual([false, false]);
  });

  it('a numeric rule never coerces: "9000", NaN, Infinity, null, booleans and arrays satisfy no refund rule', () => {
    for (const amount of ['9000', '100', Number.NaN, Infinity, null, true, [9000]]) {
      const d = evaluate(policy, call('refund_payment', { amount_inr: amount }));
      expect({ amount: JSON.stringify(amount), decision: d.decision, reason: d.reason }).toEqual({
        amount: JSON.stringify(amount),
        decision: 'deny',
        reason: 'no-matching-rule',
      });
    }
  });

  it('malformed tool calls are denied before any rule is read', () => {
    for (const bad of [
      call(undefined),
      call(42),
      call(''),
      call('lookup order'),
      call('x'.repeat(200)),
      call('a/b'),
      call(null),
    ]) {
      expect(evaluate(policy, bad)).toMatchObject({ decision: 'deny', reason: 'malformed-tool-call', tool: null });
    }
    for (const [i, badArgs] of ['{"order_id":1}', 7, [], [1], null, new Map(), new Date(0)].entries()) {
      expect(evaluate(policy, call('lookup_order', badArgs)), `case ${String(i)}`).toMatchObject({
        decision: 'deny',
        reason: 'malformed-tool-call',
        tool: 'lookup_order',
      });
    }
  });

  it('missing arguments are treated as no arguments', () => {
    expect(evaluate(policy, call('lookup_order'))).toMatchObject({ decision: 'allow' });
  });

  it('prototype tricks do not reach a rule: inherited properties are not arguments', () => {
    const inherited = Object.create({ amount_inr: 100 }) as Record<string, unknown>;
    expect(evaluate(policy, call('refund_payment', inherited))).toMatchObject({
      decision: 'deny',
      reason: 'malformed-tool-call',
    });
    const sneaky = JSON.parse('{"__proto__": {"amount_inr": 100}}') as unknown;
    expect(evaluate(policy, call('refund_payment', sneaky))).toMatchObject({
      decision: 'deny',
      reason: 'no-matching-rule',
    });
  });
});

describe('precedence, operators and determinism', () => {
  const make = (rules: unknown[]): CompiledPolicy => compilePolicy({ version: 1, rules });
  const rule = (id: string, decision: string, extra: object = {}) => ({
    id,
    source: `s:${id}`,
    tool: 't',
    decision,
    ...extra,
  });

  it('deny beats require_approval beats allow, regardless of rule order', () => {
    for (const order of [
      ['a-allow', 'b-approve', 'c-deny'],
      ['c-deny', 'b-approve', 'a-allow'],
      ['b-approve', 'c-deny', 'a-allow'],
    ]) {
      const rules = order.map((id) =>
        rule(id, id.endsWith('allow') ? 'allow' : id.endsWith('approve') ? 'require_approval' : 'deny'),
      );
      expect(evaluate(make(rules), call('t'))).toMatchObject({ decision: 'deny', rule_id: 'c-deny' });
    }
    const two = make([rule('x-allow', 'allow'), rule('y-approve', 'require_approval')]);
    expect(evaluate(two, call('t'))).toMatchObject({ decision: 'require_approval', rule_id: 'y-approve' });
  });

  it('ties are broken by rule id, and every matching rule is reported in id order', () => {
    const p = make([rule('b-deny', 'deny'), rule('a-deny', 'deny')]);
    const d = evaluate(p, call('t'));
    expect(d.rule_id).toBe('a-deny');
    expect(d.matched.map((m) => m.rule_id)).toEqual(['a-deny', 'b-deny']);
  });

  it('supports eq, neq, in, not_in, exists and nested paths, all ANDed', () => {
    const p = make([
      rule('only', 'allow', {
        when: [
          { path: 'order.region', op: 'in', value: ['in', 'eu'] },
          { path: 'order.priority', op: 'not_in', value: ['urgent'] },
          { path: 'note', op: 'exists' },
          { path: 'dry_run', op: 'eq', value: true },
          { path: 'channel', op: 'neq', value: 'sms' },
        ],
      }),
    ]);
    const good = { order: { region: 'in', priority: 'normal' }, note: 'x', dry_run: true, channel: 'email' };
    expect(evaluate(p, call('t', good)).decision).toBe('allow');
    for (const bad of [
      { ...good, order: { region: 'us', priority: 'normal' } },
      { ...good, order: { region: 'in', priority: 'urgent' } },
      { ...good, note: undefined },
      { ...good, dry_run: 'true' },
      { ...good, channel: 'sms' },
      { ...good, channel: undefined },
    ])
      expect(evaluate(p, call('t', bad)).decision, JSON.stringify(bad)).toBe('deny');
  });

  it('is deterministic: the same policy and call give identical decisions, and the policy hash is stable', () => {
    const args = { amount_inr: 9000 };
    const first = JSON.stringify(evaluate(policy, call('refund_payment', args)));
    for (let i = 0; i < 50; i += 1) expect(JSON.stringify(evaluate(policy, call('refund_payment', args)))).toBe(first);
    expect(parsePolicyYaml(demoYaml).hash).toBe(policy.hash);
    expect(policy.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('every decision carries the policy hash, and the hash changes when a rule changes', () => {
    expect(evaluate(policy, call('lookup_order')).policy_hash).toBe(policy.hash);
    expect(evaluate(policy, call('nope')).policy_hash).toBe(policy.hash);
    expect(
      parsePolicyYaml(demoYaml.replace('amount_inr, op: lte, value: 5000', 'amount_inr, op: lte, value: 5001')).hash,
    ).not.toBe(policy.hash);
  });

  it('canonicalJson sorts keys and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: [{ d: undefined, c: 2 }] })).toBe('{"a":[{"c":2}],"b":1}');
  });
});

describe('policy files are validated strictly', () => {
  const bad =
    (rules: unknown, extra: object = {}): (() => unknown) =>
    () =>
      compilePolicy({ version: 1, rules, ...extra });
  const ok = { id: 'r1', source: 's', tool: 't', decision: 'allow' };

  it('rejects a rule with no source, so nothing is uncited', () => {
    expect(bad([{ ...ok, source: '' }])).toThrow(/cite a source/);
    expect(bad([{ ...ok, source: '   ' }])).toThrow(/cite a source/);
    expect(bad([{ id: 'r1', tool: 't', decision: 'allow' }])).toThrow(/source/);
  });

  it('rejects duplicate rule ids, unknown keys, unknown decisions and a changed default', () => {
    expect(bad([ok, ok])).toThrow(/duplicate rule id "r1"/);
    expect(bad([{ ...ok, surprise: 1 }])).toThrow();
    expect(bad([{ ...ok, decision: 'maybe' }])).toThrow();
    expect(bad([ok], { default_decision: 'allow' })).toThrow();
    expect(() => compilePolicy({ version: 2, rules: [ok] })).toThrow();
    expect(bad([])).toThrow();
  });

  it('rejects ill-formed conditions', () => {
    for (const when of [
      [{ path: 'a', op: 'gt', value: '5' }],
      [{ path: 'a', op: 'in', value: 'x' }],
      [{ path: 'a', op: 'in', value: [] }],
      [{ path: 'a', op: 'exists', value: 1 }],
      [{ path: 'a', op: 'eq' }],
      [{ path: 'a', op: 'matches', value: '.*' }],
      [{ path: '__proto__.x', op: 'exists' }],
      [{ path: 'a.constructor', op: 'exists' }],
      [{ path: 'a b', op: 'exists' }],
    ])
      expect(bad([{ ...ok, when }]), JSON.stringify(when)).toThrow();
  });

  it('refuses YAML aliases, merge keys and duplicate keys, and reports YAML syntax errors', () => {
    const aliased = 'version: 1\nrules:\n  - &r { id: r1, source: s, tool: t, decision: allow }\n  - *r\n';
    expect(() => parsePolicyYaml(aliased)).toThrow();
    expect(() => parsePolicyYaml('version: 1\nversion: 1\nrules: []\n')).toThrow();
    expect(() => parsePolicyYaml('version: [1\n')).toThrow(/not valid YAML/);
    expect(() => parsePolicyYaml('just a string')).toThrow(/Invalid policy/);
  });

  it('the shipped demo policy cites a source on every rule, and invents no regulation', () => {
    expect(policy.policy.rules.length).toBeGreaterThanOrEqual(6);
    for (const r of policy.policy.rules) expect(r.source).toMatch(/^demo-policy:DEMO-\d{3}$/);
    // The forbidden word is assembled so this file itself passes the repo's wording check.
    expect(demoYaml).not.toMatch(
      new RegExp(`${['compli', 'ant'].join('')}|Article \\d|Section \\d|GDPR|DPDP|EU AI Act`, 'i'),
    );
  });
});
