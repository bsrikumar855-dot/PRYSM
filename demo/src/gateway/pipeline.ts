import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { ModelError, type ChatModel, type ParsedToolCall, type ToolDef } from '../adapter/index.ts';
import { evaluate, type CompiledPolicy, type PolicyDecision } from '../policy/index.ts';
import { countFindings, redactText, redactValue, redactionLogFields } from '../redaction/index.ts';
import { canonicalize } from '../evidence/canonical.ts';
import type { ApprovalBroker } from './approvals.ts';
import { toEvidenceValue } from './evidence-value.ts';
import type { Ledger } from './ledger.ts';
import { chatRequestSchema, toolDefsOf } from './schemas.ts';
import type { EventHub } from './events.ts';

// DEMO-ONLY (TODO(T-001), TODO(T-003)). POST /v1/chat/completions:
//   redact the messages -> ask the model -> intercept its tool requests -> let the POLICY decide -> (wait for a human
//   if the policy says require_approval) -> append evidence for every step -> return the allowed calls only.
// The model never decides anything. Its text and its tool requests are inputs; the decision is made by code from the
// policy file, or by a named human, and each of those is written to the evidence log.

export interface PipelineContext {
  model: ChatModel;
  policy: CompiledPolicy;
  ledger: Ledger;
  approvals: ApprovalBroker;
  hub: EventHub;
  db: pg.Pool;
  defaultTools: readonly ToolDef[];
  approvalTimeoutMs: number;
  clock: () => Date;
}

export interface PipelineResult {
  status: number;
  body: unknown;
}

export type Final = 'allow' | 'deny';

interface DecisionView {
  call_id: string;
  tool: string | null;
  /** What the policy said. */
  policy_decision: PolicyDecision['decision'];
  /** What happened: for require_approval this is the human's answer (or a timeout, which is a denial). */
  final: Final;
  reason: string;
  rule_id: string | null;
  source: string | null;
  approval: { id: string; outcome: string; actor: string } | null;
  evidence_seq: number[];
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const error = (status: number, code: string, message: string): PipelineResult => ({
  status,
  body: { error: { code, message } },
});

/** Cleans a human-typed approver label of PII before it is stored. */
export function cleanActor(actor: string): string {
  return redactText(actor).text.slice(0, 64);
}

export async function handleChat(ctx: PipelineContext, raw: unknown): Promise<PipelineResult> {
  const parsed = chatRequestSchema.safeParse(raw);
  if (!parsed.success)
    return error(
      400,
      'invalid_request',
      'The request body is not a valid chat completion request (streaming is not supported).',
    );
  const body = parsed.data;
  const requestId = randomUUID();
  const tools = toolDefsOf(body, ctx.defaultTools);

  // 1. Redact before anything leaves the gateway or reaches a log.
  let redacted: ReturnType<typeof redactValue>;
  try {
    redacted = redactValue(body.messages);
  } catch (e) {
    if (e instanceof RangeError) return error(400, 'invalid_request', 'The messages nest too deeply.');
    throw e;
  }
  const messages = redacted.value as { role: 'system' | 'user' | 'assistant' | 'tool'; content: string }[];
  const requestRecord = await ctx.ledger.record('request.received', 'gateway', {
    request_id: requestId,
    model: ctx.model.name,
    message_count: messages.length,
    messages_sha256: sha256(canonicalize(messages.map((m) => ({ role: m.role, content: m.content })))),
    tool_count: tools.length,
    ...redactionLogFields(redacted.findings),
  });

  // 2. Ask the model. Its answer is untrusted input.
  let result;
  try {
    result = await ctx.model.complete({ messages: messages.map((m) => ({ role: m.role, content: m.content })), tools });
  } catch (e) {
    const kind = e instanceof ModelError ? e.kind : 'network';
    await ctx.ledger.record('model.error', 'gateway', { request_id: requestId, kind });
    return error(502, 'model_unavailable', `The model could not be used (${kind}). Nothing was approved.`);
  }
  const contentRedaction = result.content === null ? null : redactText(result.content);
  const modelRecord = await ctx.ledger.record('model.response', 'gateway', {
    request_id: requestId,
    mode: result.mode,
    finish_reason: result.finishReason ?? '',
    tool_call_count: result.toolCalls.length,
    valid_calls: result.toolCalls.filter((c) => c.ok).length,
    invalid_calls: result.toolCalls.filter((c) => !c.ok).length,
    content_sha256: result.content === null ? '' : sha256(result.content),
    content_length: result.content?.length ?? 0,
    parse_notes: result.notes.length,
  });

  // 3. Decide every tool request with the policy.
  const decisions: DecisionView[] = [];
  const allowed: { id: string; name: string; arguments: Record<string, unknown> }[] = [];
  const seqs = [requestRecord.seq, modelRecord.seq];
  for (const call of result.toolCalls) {
    const view = await decideOne(ctx, requestId, call);
    decisions.push(view);
    seqs.push(...view.evidence_seq);
    if (view.final === 'allow' && call.ok)
      allowed.push({
        id: call.id,
        name: call.name,
        arguments: redactValue(call.arguments).value as Record<string, unknown>,
      });
  }

  const done = await ctx.ledger.record('request.completed', 'gateway', {
    request_id: requestId,
    allowed: decisions.filter((d) => d.final === 'allow').length,
    denied: decisions.filter((d) => d.final === 'deny').length,
    approvals: decisions.filter((d) => d.approval !== null).length,
  });

  return {
    status: 200,
    body: {
      id: `chatcmpl-${requestId}`,
      object: 'chat.completion',
      created: Math.floor(ctx.clock().getTime() / 1000),
      model: ctx.model.name,
      choices: [
        {
          index: 0,
          finish_reason: allowed.length > 0 ? 'tool_calls' : 'stop',
          message: {
            role: 'assistant',
            content: contentRedaction?.text ?? null,
            ...(allowed.length > 0
              ? {
                  tool_calls: allowed.map((c) => ({
                    id: c.id,
                    type: 'function',
                    function: { name: c.name, arguments: JSON.stringify(c.arguments) },
                  })),
                }
              : {}),
          },
        },
      ],
      prysm: {
        request_id: requestId,
        policy_hash: ctx.policy.hash,
        redaction: countFindings(redacted.findings),
        decisions,
        evidence: { first_seq: seqs[0] ?? null, last_seq: done.seq },
        notice:
          'These are control-status results from the policy file, with evidence of each step in the evidence log. A model proposed the tool requests; it did not decide them.',
      },
    },
  };
}

async function decideOne(ctx: PipelineContext, requestId: string, call: ParsedToolCall): Promise<DecisionView> {
  if (!call.ok) {
    const rec = await ctx.ledger.record('tool_call.decision', 'gateway', {
      request_id: requestId,
      call_id: call.id,
      tool: call.name ?? '',
      decision: 'deny',
      reason: 'malformed-tool-call',
      detail: call.reason,
      rule_id: '',
      source: '',
      policy_hash: ctx.policy.hash,
    });
    return {
      call_id: call.id,
      tool: call.name,
      policy_decision: 'deny',
      final: 'deny',
      reason: `malformed-tool-call: ${call.reason}`,
      rule_id: null,
      source: null,
      approval: null,
      evidence_seq: [rec.seq],
    };
  }

  const redactedArgs = redactValue(call.arguments);
  const decision = evaluate(ctx.policy, { name: call.name, arguments: redactedArgs.value });
  const evidenceArgs = toEvidenceValue(redactedArgs.value);
  const decisionRecord = await ctx.ledger.record('tool_call.decision', 'gateway', {
    request_id: requestId,
    call_id: call.id,
    tool: call.name,
    decision: decision.decision,
    reason: decision.reason,
    rule_id: decision.rule_id ?? '',
    source: decision.source ?? '',
    policy_hash: decision.policy_hash,
    matched_rules: decision.matched.map((m) => m.rule_id),
    arguments: evidenceArgs,
    ...redactionLogFields(redactedArgs.findings),
  });
  const base: DecisionView = {
    call_id: call.id,
    tool: call.name,
    policy_decision: decision.decision,
    final: decision.decision === 'allow' ? 'allow' : 'deny',
    reason: decision.reason,
    rule_id: decision.rule_id,
    source: decision.source,
    approval: null,
    evidence_seq: [decisionRecord.seq],
  };
  if (decision.decision !== 'require_approval') return base;

  // 4. A human decides. The request waits; each step is evidence.
  const pending = ctx.approvals.open(
    {
      request_id: requestId,
      call_id: call.id,
      tool: call.name,
      rule_id: decision.rule_id,
      source: decision.source,
      arguments: evidenceArgs,
      requested_at: ctx.clock().toISOString(),
    },
    ctx.approvalTimeoutMs,
  );
  const requested = await ctx.ledger.record('approval.requested', 'gateway', {
    request_id: requestId,
    approval_id: pending.id,
    call_id: call.id,
    tool: call.name,
    rule_id: decision.rule_id ?? '',
    source: decision.source ?? '',
  });
  ctx.hub.publish('approvals', { pending: ctx.approvals.list() });
  const { outcome, actor } = await pending.decision;
  ctx.hub.publish('approvals', { pending: ctx.approvals.list() });
  const resolved = await ctx.ledger.record('approval.resolved', cleanActor(actor), {
    request_id: requestId,
    approval_id: pending.id,
    call_id: call.id,
    tool: call.name,
    outcome,
    decided_by: outcome === 'timeout' ? 'timeout' : 'human',
    rule_id: decision.rule_id ?? '',
  });
  return {
    ...base,
    final: outcome === 'approved' ? 'allow' : 'deny',
    reason:
      outcome === 'approved'
        ? 'approved by a human'
        : outcome === 'denied'
          ? 'denied by a human'
          : 'no decision before the timeout, which counts as a denial',
    approval: { id: pending.id, outcome, actor: cleanActor(actor) },
    evidence_seq: [decisionRecord.seq, requested.seq, resolved.seq],
  };
}
