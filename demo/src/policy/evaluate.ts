import type { CompiledPolicy } from './compile.ts';
import type { Predicate, Rule, RuleDecision } from './schema.ts';

/** A tool call as the model proposed it. Untrusted: names and arguments are checked before any rule runs. */
export interface ToolCall {
  name: unknown;
  /** Already-parsed arguments. Must be a plain object, or absent (treated as no arguments). */
  arguments?: unknown;
}

export type DecisionReason = 'rule' | 'unknown-tool' | 'no-matching-rule' | 'malformed-tool-call';

export interface TraceEntry {
  rule_id: string;
  source: string;
  matched: boolean;
}

/** The outcome. Computed by code from the policy; no model output decides it. */
export interface PolicyDecision {
  decision: RuleDecision;
  reason: DecisionReason;
  /** The tool name when it was well formed, else null. */
  tool: string | null;
  /** The rule that decided, when reason is "rule". */
  rule_id: string | null;
  source: string | null;
  /** Every rule that matched, in id order. */
  matched: { rule_id: string; source: string; decision: RuleDecision }[];
  /** Every rule for this tool that was considered, in id order. */
  trace: TraceEntry[];
  policy_hash: string;
}

const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;
/** deny beats require_approval beats allow (ADR-0005 precedence, reduced to the three demo actions). */
const PRECEDENCE: Record<RuleDecision, number> = { deny: 3, require_approval: 2, allow: 1 };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** Looks a dotted path up through own properties only. Returns undefined when any step is missing. */
function lookup(args: Record<string, unknown>, path: string): unknown {
  let current: unknown = args;
  for (const segment of path.split('.')) {
    if (!isPlainObject(current) || !Object.hasOwn(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

function holds(predicate: Predicate, args: Record<string, unknown>): boolean {
  const actual = lookup(args, predicate.path);
  const expected = predicate.value;
  switch (predicate.op) {
    case 'exists':
      return actual !== undefined;
    case 'eq':
      return actual === expected;
    case 'neq':
      return actual !== undefined && actual !== expected;
    case 'in':
      return (
        Array.isArray(expected) &&
        (typeof actual === 'string' || typeof actual === 'number') &&
        expected.includes(actual)
      );
    case 'not_in':
      return (
        Array.isArray(expected) &&
        (typeof actual === 'string' || typeof actual === 'number') &&
        !expected.includes(actual)
      );
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte': {
      // No coercion: only a finite number compares, so "9000" or NaN never satisfies a numeric rule.
      if (typeof actual !== 'number' || !Number.isFinite(actual) || typeof expected !== 'number') return false;
      if (predicate.op === 'lt') return actual < expected;
      if (predicate.op === 'lte') return actual <= expected;
      if (predicate.op === 'gt') return actual > expected;
      return actual >= expected;
    }
  }
}

function deny(policy: CompiledPolicy, reason: DecisionReason, tool: string | null): PolicyDecision {
  return {
    decision: 'deny',
    reason,
    tool,
    rule_id: null,
    source: null,
    matched: [],
    trace: [],
    policy_hash: policy.hash,
  };
}

/**
 * Decides one tool call. Pure and deterministic: the same policy and call always give the same decision, with
 * no clock, randomness or I/O. Default deny: a tool with no rule, or no rule whose conditions hold, is denied.
 * Malformed names or arguments are denied before any rule is read.
 */
export function evaluate(policy: CompiledPolicy, call: ToolCall): PolicyDecision {
  if (typeof call.name !== 'string' || !TOOL_NAME.test(call.name)) return deny(policy, 'malformed-tool-call', null);
  const tool = call.name;
  const args = call.arguments === undefined ? {} : call.arguments;
  if (!isPlainObject(args)) return deny(policy, 'malformed-tool-call', tool);

  const candidates: Rule[] = policy.policy.rules.filter((r) => r.tool === tool).sort((a, b) => (a.id < b.id ? -1 : 1));
  if (candidates.length === 0) return deny(policy, 'unknown-tool', tool);

  const trace: TraceEntry[] = candidates.map((rule) => ({
    rule_id: rule.id,
    source: rule.source,
    matched: rule.when.every((p) => holds(p, args)),
  }));
  const matchedRules = candidates.filter((_, i) => trace[i]?.matched === true);
  const matched = matchedRules.map((r) => ({ rule_id: r.id, source: r.source, decision: r.decision }));
  if (matchedRules.length === 0) return { ...deny(policy, 'no-matching-rule', tool), trace };

  const winner = matchedRules.reduce((best, rule) =>
    PRECEDENCE[rule.decision] > PRECEDENCE[best.decision] ? rule : best,
  );
  return {
    decision: winner.decision,
    reason: 'rule',
    tool,
    rule_id: winner.id,
    source: winner.source,
    matched,
    trace,
    policy_hash: policy.hash,
  };
}
