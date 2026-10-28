import { z } from 'zod';
import type { ChatResult, ParsedToolCall, ToolDef } from './types.ts';

// DEMO-ONLY (TODO(T-001)). Turns an OpenAI-shaped chat completion into a ChatResult.
//   Mode A: native `tool_calls` on the assistant message.
//   Mode B: if `tool_calls` is missing or does not have the expected structure, look for a JSON tool request in the
//           text, validated with zod.
// Anything malformed, oversized, or naming a tool that was not offered becomes a call with ok:false, which the
// gateway denies and logs. Nothing here guesses.

const MAX_ARGUMENT_BYTES = 64 * 1024;
const MAX_CALLS = 8;
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;

const nativeCallSchema = z.looseObject({
  id: z.string().min(1).max(256).optional(),
  type: z.literal('function'),
  function: z.looseObject({ name: z.string(), arguments: z.string() }),
});
const nativeCallsSchema = z.array(nativeCallSchema).min(1).max(MAX_CALLS);

const messageSchema = z.looseObject({
  role: z.string().optional(),
  content: z.union([z.string(), z.null()]).optional(),
  tool_calls: z.unknown().optional(),
});
const completionSchema = z.looseObject({
  choices: z.array(z.looseObject({ message: messageSchema, finish_reason: z.string().nullable().optional() })).min(1),
});

const promptedCallSchema = z.strictObject({
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()).default({}),
});
const promptedSchema = z.union([
  z.strictObject({ tool_calls: z.array(promptedCallSchema).min(1).max(MAX_CALLS) }),
  z.strictObject({ tool: z.string(), arguments: z.record(z.string(), z.unknown()).default({}) }),
]);

function parseArguments(raw: string): { ok: true; value: Record<string, unknown> } | { ok: false; reason: string } {
  if (Buffer.byteLength(raw, 'utf8') > MAX_ARGUMENT_BYTES) return { ok: false, reason: 'arguments are too large' };
  let value: unknown;
  try {
    value = JSON.parse(raw.trim() === '' ? '{}' : raw);
  } catch {
    return { ok: false, reason: 'arguments are not valid JSON' };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return { ok: false, reason: 'arguments are not a JSON object' };
  return { ok: true, value: value as Record<string, unknown> };
}

function checkOffered(name: string, offered: ReadonlySet<string>, id: string): ParsedToolCall | null {
  if (!TOOL_NAME.test(name)) return { ok: false, id, name: null, reason: 'tool name is not well formed' };
  if (!offered.has(name))
    return { ok: false, id, name, reason: 'unknown-tool: the model asked for a tool that was not offered' };
  return null;
}

function nativeCalls(calls: z.infer<typeof nativeCallsSchema>, offered: ReadonlySet<string>): ParsedToolCall[] {
  return calls.map((call, i) => {
    const id = call.id ?? `call_${String(i)}`;
    const name = call.function.name;
    const refused = checkOffered(name, offered, id);
    if (refused) return refused;
    const args = parseArguments(call.function.arguments);
    return args.ok ? { ok: true, id, name, arguments: args.value } : { ok: false, id, name, reason: args.reason };
  });
}

/** Pulls a JSON object out of text: the whole text, a fenced block, or the outermost braces. Returns undefined if none parses. */
function extractJson(text: string): unknown {
  const candidates: string[] = [text.trim()];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

function promptedCalls(
  content: string,
  offered: ReadonlySet<string>,
): { calls: ParsedToolCall[]; matched: boolean; note?: string } {
  const json = extractJson(content);
  if (json === undefined || typeof json !== 'object') return { calls: [], matched: false };
  const parsed = promptedSchema.safeParse(json);
  if (!parsed.success) {
    // It looked like JSON but not like a tool request. Only treat it as a malformed request if it mentions one.
    const looksLikeRequest = typeof json === 'object' && json !== null && ('tool' in json || 'tool_calls' in json);
    return looksLikeRequest
      ? {
          calls: [{ ok: false, id: 'prompted_0', name: null, reason: 'the JSON tool request has the wrong shape' }],
          matched: true,
        }
      : { calls: [], matched: false };
  }
  const items =
    'tool_calls' in parsed.data
      ? parsed.data.tool_calls
      : [{ name: parsed.data.tool, arguments: parsed.data.arguments }];
  const calls = items.map((item, i): ParsedToolCall => {
    const id = `prompted_${String(i)}`;
    const refused = checkOffered(item.name, offered, id);
    if (refused) return refused;
    if (Buffer.byteLength(JSON.stringify(item.arguments), 'utf8') > MAX_ARGUMENT_BYTES)
      return { ok: false, id, name: item.name, reason: 'arguments are too large' };
    return { ok: true, id, name: item.name, arguments: item.arguments };
  });
  return { calls, matched: true };
}

export type ParseOptions = { tools: readonly ToolDef[]; toolMode: 'native' | 'prompted' | 'auto' };

/**
 * Parses a raw chat completion body (already JSON-decoded). Throws ZodError-free: a body that is not a chat
 * completion at all returns null so the caller can raise a ModelError.
 */
export function parseCompletion(body: unknown, options: ParseOptions): ChatResult | null {
  const completion = completionSchema.safeParse(body);
  if (!completion.success) return null;
  const choice = completion.data.choices[0];
  if (!choice) return null;
  const content = typeof choice.message.content === 'string' ? choice.message.content : null;
  const finishReason = choice.finish_reason ?? null;
  const offered = new Set(options.tools.map((t) => t.name));
  const notes: string[] = [];

  if (
    options.toolMode !== 'prompted' &&
    choice.message.tool_calls !== undefined &&
    choice.message.tool_calls !== null
  ) {
    const native = nativeCallsSchema.safeParse(choice.message.tool_calls);
    if (native.success)
      return { content, toolCalls: nativeCalls(native.data, offered), mode: 'native-tool-calls', finishReason, notes };
    notes.push('tool_calls was present but malformed; trying the prompted-JSON fallback');
  } else if (options.toolMode !== 'prompted') {
    notes.push('no native tool_calls');
  }

  if (options.toolMode !== 'native' && content !== null) {
    const prompted = promptedCalls(content, offered);
    if (prompted.matched) return { content, toolCalls: prompted.calls, mode: 'prompted-json', finishReason, notes };
  }
  // tool_calls was present but unusable and nothing else matched: that is a malformed request, not "no request".
  if (notes.some((n) => n.includes('malformed'))) {
    return {
      content,
      toolCalls: [{ ok: false, id: 'call_0', name: null, reason: 'tool_calls was malformed' }],
      mode: 'native-tool-calls',
      finishReason,
      notes,
    };
  }
  return { content, toolCalls: [], mode: 'none', finishReason, notes };
}

/** The instruction used in 'prompted' mode, so any model that can write JSON can request a tool. */
export function promptedInstructions(tools: readonly ToolDef[]): string {
  const list = tools.map((t) => `- ${t.name}: ${t.description}`).join('\n');
  return [
    'You can request tools. To request one, reply with ONLY a JSON object and no other text:',
    '{"tool_calls":[{"name":"<tool name>","arguments":{...}}]}',
    'Available tools:',
    list,
    'If no tool is needed, answer normally. A separate system decides whether any request is carried out.',
  ].join('\n');
}
