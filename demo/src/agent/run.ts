// DEMO-ONLY (TODO(T-001), TODO(T-003)). `pnpm demo:agent`: runs the three scenarios against the demo server.
//   --auto-approve <label>   approve the approval-required call automatically as <label> (DEMO-ONLY auto approver);
//                            without it the run waits for you to click Approve or Deny in the dashboard.
//   --base <url>             the demo server (default http://127.0.0.1:4300)
import { parseArgs } from 'node:util';
import { SCENARIOS, executeTool, type Scenario } from './scenarios.ts';

interface Decision {
  call_id: string;
  tool: string | null;
  policy_decision: 'allow' | 'deny' | 'require_approval';
  final: 'allow' | 'deny';
  reason: string;
  rule_id: string | null;
  source: string | null;
  approval: { id: string; outcome: string; actor: string } | null;
}
interface GatewayAnswer {
  choices: {
    message: { content: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] };
  }[];
  prysm: {
    request_id: string;
    decisions: Decision[];
    redaction: Record<string, number>;
    evidence: { first_seq: number | null; last_seq: number };
  };
}

export interface ScenarioOutcome {
  scenario: Scenario;
  decision: Decision | null;
  executed: string[];
  redaction: Record<string, number>;
  matchedExpectation: boolean;
}

export interface RunOptions {
  baseUrl: string;
  autoApprove: string | null;
  fetchImpl?: typeof fetch;
  say?: (line: string) => void;
}

export async function runScenarios(options: RunOptions): Promise<ScenarioOutcome[]> {
  const f = options.fetchImpl ?? fetch;
  const say = options.say ?? ((line: string) => process.stdout.write(`${line}\n`));
  const outcomes: ScenarioOutcome[] = [];

  for (const scenario of SCENARIOS) {
    say(`\n${scenario.title}`);
    say(`  agent asks: ${scenario.prompt}`);
    const flag = { stop: false };
    const approver = options.autoApprove
      ? (async () => {
          // DEMO-ONLY auto approver: polls the queue and approves as the given label, so a headless run can finish.
          while (!flag.stop) {
            const res = await f(`${options.baseUrl}/demo/approvals`);
            const { pending } = (await res.json()) as { pending: { id: string; tool: string }[] };
            for (const p of pending) {
              say(
                `  [approval queue] ${p.tool} is waiting; approving as "${options.autoApprove ?? ''}" (DEMO-ONLY auto approver)`,
              );
              await f(`${options.baseUrl}/demo/approvals/${p.id}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-demo-action': '1' },
                body: JSON.stringify({ decision: 'approve', actor: options.autoApprove }),
              });
            }
            await new Promise((r) => setTimeout(r, 100));
          }
        })()
      : null;
    if (!options.autoApprove && scenario.expect.policy_decision === 'require_approval') {
      say(`  waiting for a human: open ${options.baseUrl}/ and approve or deny this call...`);
    }

    const response = await f(`${options.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: scenario.prompt }] }),
    });
    flag.stop = true;
    await approver;
    if (!response.ok) {
      say(`  gateway answered HTTP ${String(response.status)}: nothing was approved`);
      outcomes.push({ scenario, decision: null, executed: [], redaction: {}, matchedExpectation: false });
      continue;
    }
    const answer = (await response.json()) as GatewayAnswer;
    const decision = answer.prysm.decisions[0] ?? null;
    const executed = (answer.choices[0]?.message.tool_calls ?? []).map((call) =>
      executeTool(call.function.name, JSON.parse(call.function.arguments) as Record<string, unknown>),
    );
    const counts = Object.entries(answer.prysm.redaction)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${String(n)} ${k}`)
      .join(', ');
    say(`  redaction before the model: ${counts === '' ? 'nothing to redact' : counts}`);
    if (decision) {
      say(
        `  policy: ${decision.policy_decision} (${decision.rule_id ?? decision.reason}${decision.source ? `, source ${decision.source}` : ''})`,
      );
      if (decision.approval) say(`  human decision: ${decision.approval.outcome} by ${decision.approval.actor}`);
      say(`  final: ${decision.final}`);
    }
    say(executed.length > 0 ? `  agent ran: ${executed.join('; ')}` : '  agent ran nothing (no tool call was allowed)');
    say(
      `  evidence records ${answer.prysm.evidence.first_seq === null ? '?' : String(answer.prysm.evidence.first_seq)}..${String(answer.prysm.evidence.last_seq)}`,
    );

    const matched =
      decision !== null &&
      decision.policy_decision === scenario.expect.policy_decision &&
      decision.final === scenario.expect.final &&
      executed.length > 0 === scenario.expect.executes;
    if (!matched) say('  UNEXPECTED: this does not match what the policy should produce for this scenario');
    outcomes.push({ scenario, decision, executed, redaction: answer.prysm.redaction, matchedExpectation: matched });
  }

  const verify = await f(`${options.baseUrl}/demo/verify`).then(
    (r) => r.json() as Promise<{ result: { ok: boolean; length?: number; index?: number; reason?: string } }>,
  );
  say(
    `\nevidence log: ${verify.result.ok ? `chain verified, ${String(verify.result.length)} records` : `FAILED at index ${String(verify.result.index)} (${verify.result.reason ?? ''})`}`,
  );
  return outcomes;
}

const isMain = process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const { values } = parseArgs({
    // pnpm forwards a literal "--", which parseArgs would otherwise treat as the end of the options.
    args: process.argv.slice(2).filter((a) => a !== '--'),
    options: { 'auto-approve': { type: 'string' }, base: { type: 'string' } },
    strict: true,
  });
  const outcomes = await runScenarios({
    baseUrl: values.base ?? 'http://127.0.0.1:4300',
    autoApprove: values['auto-approve'] ?? process.env['DEMO_AUTO_APPROVE'] ?? null,
  });
  process.exit(outcomes.every((o) => o.matchedExpectation) ? 0 : 1);
}
