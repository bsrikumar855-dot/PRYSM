import type { ToolDef } from './types.ts';

/** DEMO-ONLY (TODO(T-001)). The tools the demo agent is offered. Names match the rules in policies/demo-policy.yaml. */
export const DEMO_TOOLS: readonly ToolDef[] = [
  {
    name: 'lookup_order',
    description: 'Read an order record by id.',
    parameters: { type: 'object', properties: { order_id: { type: 'string' } }, required: ['order_id'] },
  },
  {
    name: 'refund_payment',
    description: 'Refund a payment in INR.',
    parameters: {
      type: 'object',
      properties: { order_id: { type: 'string' }, amount_inr: { type: 'integer' } },
      required: ['order_id', 'amount_inr'],
    },
  },
  {
    name: 'export_customer_data',
    description: 'Export customer records in bulk.',
    parameters: { type: 'object', properties: { scope: { type: 'string' } }, required: ['scope'] },
  },
  {
    name: 'send_email',
    description: 'Send an email.',
    parameters: {
      type: 'object',
      properties: { audience: { type: 'string' }, subject: { type: 'string' } },
      required: ['audience'],
    },
  },
];
