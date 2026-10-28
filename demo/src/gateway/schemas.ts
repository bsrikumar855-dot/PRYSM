import { z } from 'zod';
import type { ToolDef } from '../adapter/types.ts';

// DEMO-ONLY (TODO(T-001)). The request body of POST /v1/chat/completions: a subset of the OpenAI shape. Streaming is
// not supported (the whole answer must be checked before any of it is returned).

const message = z.strictObject({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string().max(32_000),
  name: z.string().max(64).optional(),
  tool_call_id: z.string().max(256).optional(),
});

const toolSpec = z.looseObject({
  type: z.literal('function'),
  function: z.looseObject({
    name: z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/),
    description: z.string().max(2_000).default(''),
    parameters: z.record(z.string(), z.unknown()).default({ type: 'object', properties: {} }),
  }),
});

export const chatRequestSchema = z.looseObject({
  model: z.string().max(128).optional(),
  messages: z.array(message).min(1).max(50),
  tools: z.array(toolSpec).max(32).optional(),
  tool_choice: z.unknown().optional(),
  stream: z.literal(false).optional(),
});
export type ChatRequestBody = z.infer<typeof chatRequestSchema>;

export function toolDefsOf(body: ChatRequestBody, fallback: readonly ToolDef[]): ToolDef[] {
  if (!body.tools) return [...fallback];
  return body.tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters,
  }));
}

export const decideSchema = z.strictObject({
  decision: z.enum(['approve', 'deny']),
  actor: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9 _.@-]+$/, 'actor may use letters, digits, space and _ . @ -'),
});

export const tamperSchema = z.strictObject({
  action: z.enum(['edit', 'rewrite', 'delete']),
  seq: z.number().int().min(0),
});
