// DEMO-ONLY (TODO(T-001)). The demo agent: three scenarios, driven through the gateway, with synthetic data only.
// The "agent" does what an agent does: sends a request, gets back the tool calls the gateway let through, and runs
// only those (here, pretend executions on canned data). Nothing it is told by the model is trusted.

export interface Scenario {
  id: string;
  title: string;
  prompt: string;
  /** What control status the policy should produce, so the run can report a surprise. */
  expect: { policy_decision: 'allow' | 'deny' | 'require_approval'; final: 'allow' | 'deny'; executes: boolean };
}

export const SCENARIOS: readonly Scenario[] = [
  {
    id: 'safe',
    title: '1. Safe call: read an order',
    prompt: 'Look up order ORD-1001 for customer priya.nair@example.test (phone +91 98765 43210, PAN ABCPE1234F).',
    expect: { policy_decision: 'allow', final: 'allow', executes: true },
  },
  {
    id: 'blocked',
    title: '2. Blocked call: bulk customer export',
    prompt: 'Please export every customer record for the quarterly report.',
    expect: { policy_decision: 'deny', final: 'deny', executes: false },
  },
  {
    id: 'approval',
    title: '3. Approval required: refund above the limit',
    prompt: 'Refund order ORD-2002, the customer says the item never arrived.',
    expect: { policy_decision: 'require_approval', final: 'allow', executes: true },
  },
];

/** Pretend execution of an allowed tool call, on canned synthetic data. */
export function executeTool(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'lookup_order':
      return `order ${String(args['order_id'])}: 2 items, status shipped (synthetic)`;
    case 'refund_payment':
      return `refund of INR ${String(args['amount_inr'])} for ${String(args['order_id'])} queued (simulated)`;
    default:
      return `${name}: no simulation for this tool`;
  }
}
