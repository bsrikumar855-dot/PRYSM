import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readChain } from '../evidence/store.ts';
import { startTestServer, type TestServer } from '../test-support/server.ts';
import { runScenarios } from './run.ts';
import { SCENARIOS, executeTool } from './scenarios.ts';

let t: TestServer;
beforeAll(async () => {
  t = await startTestServer('demo_agent');
  await t.reset();
});
afterAll(async () => {
  await t.stop();
});

describe('the demo agent drives the three scenarios through the gateway in replay mode', () => {
  it('runs end to end: safe allowed, blocked denied, approval-required approved by the auto approver', async () => {
    const lines: string[] = [];
    const outcomes = await runScenarios({ baseUrl: t.base, autoApprove: 'demo-script', say: (l) => lines.push(l) });
    expect(outcomes.map((o) => o.scenario.id)).toEqual(['safe', 'blocked', 'approval']);
    expect(outcomes.every((o) => o.matchedExpectation)).toBe(true);
    expect(outcomes[0]).toMatchObject({
      decision: { policy_decision: 'allow', final: 'allow' },
      executed: [expect.stringContaining('ORD-1001') as string],
    });
    expect(outcomes[1]).toMatchObject({ decision: { policy_decision: 'deny', final: 'deny' }, executed: [] });
    expect(outcomes[2]).toMatchObject({
      decision: {
        policy_decision: 'require_approval',
        final: 'allow',
        approval: { outcome: 'approved', actor: 'demo-script' },
      },
    });
    expect(outcomes[2]?.executed[0]).toContain('INR 9000');
    expect(lines.join('\n')).toContain('chain verified');
  });

  it('left a verifiable chain with the approval and its actor as evidence, and no raw PII', async () => {
    const chain = await readChain(t.db);
    const docs = chain.map(
      (r) => JSON.parse(r.canonical) as { type: string; actor: string; data: Record<string, unknown> },
    );
    expect(docs.some((d) => d.type === 'approval.resolved' && d.actor === 'demo-script')).toBe(true);
    const text = JSON.stringify(docs);
    for (const pii of ['priya.nair@example.test', '98765 43210', 'ABCPE1234F']) expect(text).not.toContain(pii);
    expect(docs[0]?.data).toMatchObject({ redaction_counts: { email: 1, phone: 1, pan: 1 } });
  });

  it('reports a mismatch when the server is unreachable instead of pretending', async () => {
    const lines: string[] = [];
    const failing = ((): Promise<Response> =>
      Promise.resolve(new Response('{}', { status: 502 }))) as unknown as typeof fetch;
    const outcomes = await runScenarios({
      baseUrl: 'http://127.0.0.1:1',
      autoApprove: null,
      fetchImpl: failing,
      say: (l) => lines.push(l),
    }).catch(() => []);
    expect(outcomes.every((o) => !o.matchedExpectation)).toBe(true);
  });

  it('simulates only the tools it knows and says so for the rest', () => {
    expect(executeTool('lookup_order', { order_id: 'ORD-1' })).toContain('ORD-1');
    expect(executeTool('send_email', {})).toContain('no simulation');
    expect(SCENARIOS).toHaveLength(3);
  });
});
