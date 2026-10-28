// DEMO-ONLY (TODO(T-001)). One live check of the Meta Model API: ONE plain chat call and ONE tool-calling call, with
// synthetic prompts. It prints the SHAPE of what came back (keys and types, plus the parsed tool request), never the
// API key. With no key in .env.demo it prints SKIPPED and exits 0.
//
//   .env.demo (untracked): META_MODEL_API_KEY=...  META_MODEL_API_BASE_URL=https://api.meta.ai/v1  META_MODEL_NAME=muse-spark-1.3
//   pnpm demo:live-check
import { MetaChatModel, metaConfigFromEnv, parseCompletion } from '../src/adapter/index.ts';
import { DEMO_TOOLS } from '../src/adapter/tools.ts';

const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

/** Describes a JSON value by structure and type only, so no content (and nothing secret) is printed. */
function shape(value: unknown, depth = 0): string {
  if (value === null) return 'null';
  if (Array.isArray(value))
    return depth > 4
      ? '[...]'
      : `[${value
          .slice(0, 2)
          .map((v) => shape(v, depth + 1))
          .join(', ')}${value.length > 2 ? `, ...(${String(value.length)} items)` : ''}]`;
  if (typeof value === 'object') {
    if (depth > 4) return '{...}';
    return `{${Object.entries(value)
      .map(([k, v]) => `${k}: ${shape(v, depth + 1)}`)
      .join(', ')}}`;
  }
  return typeof value;
}

const config = metaConfigFromEnv();
if (!config) {
  out('SKIPPED: META_MODEL_API_KEY is not set (put it in an untracked .env.demo). Nothing was called.');
  process.exit(0);
}
const model = new MetaChatModel(config);
out(`model: ${config.model}  base URL: ${config.baseUrl}  key: [redacted, ${String(config.apiKey.length)} characters]`);

let failures = 0;
const check = (label: string, ok: boolean, detail: string): void => {
  out(`${ok ? 'PASS' : 'FAIL'}  ${label}: ${detail}`);
  if (!ok) failures += 1;
};

try {
  const chat = await model.completeRaw({
    messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
    tools: [],
  });
  out(`1. chat call -> HTTP ${String(chat.status)}`);
  out(`   response shape: ${shape(chat.body)}`);
  const parsed = parseCompletion(chat.body, { tools: [], toolMode: 'auto' });
  check(
    'chat completion parses as an OpenAI-style completion',
    parsed !== null && parsed.content !== null,
    parsed
      ? `finish_reason=${parsed.finishReason ?? 'null'}, text length ${String(parsed.content?.length ?? 0)}`
      : 'not a chat completion',
  );

  const tool = await model.completeRaw({
    messages: [{ role: 'user', content: 'Look up order ORD-1001 using the tool.' }],
    tools: [...DEMO_TOOLS],
  });
  out(`2. tool-calling call -> HTTP ${String(tool.status)}`);
  out(`   response shape: ${shape(tool.body)}`);
  const result = parseCompletion(tool.body, { tools: DEMO_TOOLS, toolMode: 'auto' });
  const call = result?.toolCalls[0];
  check(
    'a tool call came back',
    call !== undefined,
    result ? `mode=${result.mode}, calls=${String(result.toolCalls.length)}` : 'not a chat completion',
  );
  check('it is Mode A (native tool_calls)', result?.mode === 'native-tool-calls', `mode=${result?.mode ?? 'n/a'}`);
  check(
    'the call is valid and names an offered tool',
    call?.ok === true,
    call ? (call.ok ? `${call.name}(${JSON.stringify(call.arguments)})` : call.reason) : 'no call',
  );
} catch (error) {
  failures += 1;
  out(`FAIL  ${error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error'}`);
}
out(
  failures === 0
    ? 'RESULT: the documented OpenAI-compatible chat and tool-calling shape works.'
    : 'RESULT: the live API did NOT match the expected shape; do not rely on the adapter until this is resolved.',
);
process.exit(failures === 0 ? 0 : 1);
