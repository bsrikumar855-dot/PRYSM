import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  MetaChatModel,
  ModelError,
  RecordingChatModel,
  ReplayChatModel,
  loadFixtures,
  metaConfigFromEnv,
  parseCompletion,
  promptedInstructions,
  requestHash,
  type ChatRequest,
} from './index.ts';
import { DEMO_TOOLS } from './tools.ts';

const FIXTURES = new URL('../../fixtures/replay.json', import.meta.url).pathname;
const fixtures = loadFixtures(FIXTURES);
const req = (user: string, extra: Partial<ChatRequest> = {}): ChatRequest => ({
  messages: [{ role: 'user', content: user }],
  tools: [...DEMO_TOOLS],
  ...extra,
});

const ok = (body: unknown, status = 200) =>
  vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status })));
const nativeBody = (calls: unknown, content: string | null = null) => ({
  choices: [{ index: 0, message: { role: 'assistant', content, tool_calls: calls }, finish_reason: 'tool_calls' }],
});
const fn = (name: string, args: string, id = 'c1') => ({ id, type: 'function', function: { name, arguments: args } });
const parse = (body: unknown, toolMode: 'native' | 'prompted' | 'auto' = 'auto') =>
  parseCompletion(body, { tools: DEMO_TOOLS, toolMode });

describe('Mode A: native tool_calls', () => {
  it('parses a valid call and keeps its id', () => {
    const r = parse(nativeBody([fn('lookup_order', '{"order_id":"ORD-1"}', 'abc')]));
    expect(r).toMatchObject({
      mode: 'native-tool-calls',
      toolCalls: [{ ok: true, id: 'abc', name: 'lookup_order', arguments: { order_id: 'ORD-1' } }],
    });
  });

  it('parses parallel calls in order', () => {
    const r = parse(nativeBody([fn('lookup_order', '{}', 'a'), fn('refund_payment', '{"amount_inr":5}', 'b')]));
    expect(r?.toolCalls.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('empty argument text means no arguments', () => {
    expect(parse(nativeBody([fn('lookup_order', '')]))?.toolCalls[0]).toMatchObject({ ok: true, arguments: {} });
  });

  it('a call with bad arguments is carried forward as not ok, not dropped and not repaired', () => {
    for (const args of ['{not json', '[1,2]', '"text"', '7', 'null', 'x'.repeat(70_000)]) {
      const r = parse(nativeBody([fn('lookup_order', args)]));
      expect(r?.toolCalls[0], args.slice(0, 12)).toMatchObject({ ok: false, name: 'lookup_order' });
    }
  });

  it('a tool that was not offered is not ok, and a malformed name is not ok', () => {
    expect(parse(nativeBody([fn('delete_database', '{}')]))?.toolCalls[0]).toMatchObject({
      ok: false,
      name: 'delete_database',
      reason: expect.stringContaining('unknown-tool') as string,
    });
    expect(parse(nativeBody([fn('look up', '{}')]))?.toolCalls[0]).toMatchObject({ ok: false, name: null });
  });

  it('native calls win over JSON in the text', () => {
    const r = parse(nativeBody([fn('lookup_order', '{}')], '{"tool":"refund_payment","arguments":{}}'));
    expect(r?.mode).toBe('native-tool-calls');
    expect(r?.toolCalls).toHaveLength(1);
  });

  it('malformed tool_calls structure with nothing in the text is one denied call, not "no request"', () => {
    for (const bad of [[{ nope: 1 }], 'text', 7, [], [fn('lookup_order', '{}'), { type: 'function' }]]) {
      const r = parse(nativeBody(bad));
      expect(r?.toolCalls, JSON.stringify(bad)).toEqual([
        { ok: false, id: 'call_0', name: null, reason: 'tool_calls was malformed' },
      ]);
    }
  });

  it('more than eight calls is malformed', () => {
    expect(
      parse(nativeBody(Array.from({ length: 9 }, (_, i) => fn('lookup_order', '{}', `c${String(i)}`))))?.toolCalls[0],
    ).toMatchObject({ ok: false });
  });
});

describe('Mode B: prompted JSON', () => {
  const textBody = (content: string) => ({
    choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
  });

  it('reads a bare JSON request, a fenced one, and one with chatter around it', () => {
    const json = '{"tool_calls":[{"name":"send_email","arguments":{"audience":"external"}}]}';
    for (const content of [json, `\`\`\`json\n${json}\n\`\`\``, `Sure! ${json} Hope that helps.`]) {
      expect(parse(textBody(content))).toMatchObject({
        mode: 'prompted-json',
        toolCalls: [{ ok: true, name: 'send_email', arguments: { audience: 'external' } }],
      });
    }
  });

  it('reads the single-tool shape', () => {
    expect(parse(textBody('{"tool":"lookup_order","arguments":{"order_id":"ORD-9"}}'))?.toolCalls[0]).toMatchObject({
      ok: true,
      name: 'lookup_order',
    });
  });

  it('falls back to it when native tool_calls is present but malformed', () => {
    const r = parse(nativeBody('garbage', '{"tool":"lookup_order","arguments":{}}'));
    expect(r).toMatchObject({ mode: 'prompted-json', toolCalls: [{ ok: true, name: 'lookup_order' }] });
    expect(r?.notes.join(' ')).toContain('malformed');
  });

  it('an offered-tool check, size limit and shape check still apply', () => {
    expect(parse(textBody('{"tool":"delete_database","arguments":{}}'))?.toolCalls[0]).toMatchObject({
      ok: false,
      name: 'delete_database',
    });
    expect(
      parse(textBody(`{"tool":"lookup_order","arguments":{"x":"${'a'.repeat(70_000)}"}}`))?.toolCalls[0],
    ).toMatchObject({ ok: false });
    expect(parse(textBody('{"tool":"lookup_order","arguments":[1]}'))?.toolCalls[0]).toMatchObject({
      ok: false,
      reason: expect.stringContaining('wrong shape') as string,
    });
    expect(
      parse(textBody('{"tool_calls":[{"name":"lookup_order","arguments":{},"extra":1}]}'))?.toolCalls[0],
    ).toMatchObject({ ok: false });
  });

  it('ordinary text and unrelated JSON are not tool requests', () => {
    for (const content of ['I can help with that.', '{"answer": 42}', '[1,2,3]', '{broken', '']) {
      expect(parse(textBody(content)), content).toMatchObject({ mode: 'none', toolCalls: [] });
    }
  });

  it('native mode ignores text JSON, and prompted mode ignores native calls', () => {
    expect(parse(textBody('{"tool":"lookup_order","arguments":{}}'), 'native')?.toolCalls).toEqual([]);
    expect(parse(nativeBody([fn('lookup_order', '{}')]), 'prompted')?.mode).toBe('none');
  });

  it('builds prompted instructions that list each offered tool', () => {
    const text = promptedInstructions(DEMO_TOOLS);
    for (const t of DEMO_TOOLS) expect(text).toContain(t.name);
  });
});

describe('response caps', () => {
  const BIG = 500_000;
  const quickly = (run: () => unknown) => {
    const start = performance.now();
    const result = run();
    expect(performance.now() - start).toBeLessThan(250);
    return result;
  };

  it('rejects an oversized choices array without walking it', () => {
    expect(quickly(() => parse({ choices: Array.from({ length: BIG }, () => ({})) }))).toBeNull();
    expect(
      quickly(() => parse({ choices: Array.from({ length: 9 }, () => ({ message: { content: 'x' } })) })),
    ).toBeNull();
  });

  it('treats an oversized native tool_calls array as one denied call', () => {
    const r = quickly(() => parse(nativeBody(Array.from({ length: BIG }, () => ({ nope: 1 }))))) as ReturnType<
      typeof parse
    >;
    expect(r?.toolCalls).toEqual([{ ok: false, id: 'call_0', name: null, reason: 'tool_calls was malformed' }]);
  });

  it('treats an oversized prompted tool_calls array as a malformed request', () => {
    const text = JSON.stringify({ tool_calls: Array.from({ length: 50_000 }, () => 1) });
    const r = quickly(() => parse({ choices: [{ message: { content: text } }] }, 'prompted')) as ReturnType<
      typeof parse
    >;
    expect(r?.toolCalls).toEqual([
      { ok: false, id: 'prompted_0', name: null, reason: 'the JSON tool request has the wrong shape' },
    ]);
  });

  it('rejects content over 128 KiB and arguments over 64 KiB', () => {
    expect(parse({ choices: [{ message: { content: 'a'.repeat(128 * 1024 + 1) } }] })).toBeNull();
    const big = JSON.stringify({ note: 'a'.repeat(64 * 1024) });
    expect(parse(nativeBody([fn('lookup_order', big)]))?.toolCalls[0]).toMatchObject({
      ok: false,
      reason: 'arguments are too large',
    });
    expect(parse({ choices: [{ message: { content: 'a'.repeat(128 * 1024) } }] })?.toolCalls).toEqual([]);
  });
});

describe('response validation', () => {
  it('returns null for bodies that are not chat completions', () => {
    for (const bad of [
      null,
      {},
      [],
      'x',
      { choices: [] },
      { choices: [{}] },
      { choices: [{ message: { content: 5 } }] },
    ]) {
      expect(parse(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('MetaChatModel', () => {
  const config = (fetchImpl: typeof fetch, extra: object = {}) => ({
    baseUrl: 'https://api.meta.ai/v1/',
    apiKey: 'sk-demo-secret-123',
    model: 'muse-spark-1.3',
    fetchImpl,
    ...extra,
  });

  it('posts to /chat/completions with a bearer key, the tools and the model, and parses the answer', async () => {
    const fetchImpl = ok(nativeBody([fn('lookup_order', '{"order_id":"ORD-1"}')]));
    const model = new MetaChatModel(config(fetchImpl));
    const result = await model.complete(req('look up ORD-1'));
    expect(result.toolCalls[0]).toMatchObject({ ok: true, name: 'lookup_order' });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.meta.ai/v1/chat/completions');
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer sk-demo-secret-123');
    const sent = JSON.parse(init.body as string) as {
      model: string;
      tools: { type: string; function: { name: string } }[];
      messages: unknown[];
    };
    expect(sent.model).toBe('muse-spark-1.3');
    expect(sent.tools.map((t) => t.function.name)).toEqual(DEMO_TOOLS.map((t) => t.name));
    expect(JSON.stringify(sent)).not.toContain('sk-demo-secret');
    expect(init.redirect).toBe('error');
  });

  it('prompted mode sends no tools and prepends the instructions', async () => {
    const fetchImpl = ok({
      choices: [{ message: { role: 'assistant', content: '{"tool":"lookup_order","arguments":{}}' } }],
    });
    const result = await new MetaChatModel(config(fetchImpl)).complete(req('hi', { toolMode: 'prompted' }));
    expect(result.mode).toBe('prompted-json');
    const sent = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string) as {
      tools?: unknown;
      messages: { role: string }[];
    };
    expect(sent.tools).toBeUndefined();
    expect(sent.messages[0]?.role).toBe('system');
  });

  it('never puts the key in an error, for HTTP errors, network errors, timeouts or bad bodies', async () => {
    const cases: [typeof fetch, string][] = [
      [ok({ error: 'nope' }, 401), 'http'],
      [vi.fn(() => Promise.reject(new Error('connect ECONNREFUSED sk-demo-secret-123'))), 'network'],
      [vi.fn(() => Promise.resolve(new Response('not json', { status: 200 }))), 'invalid-response'],
      [ok({ nothing: true }), 'invalid-response'],
    ];
    for (const [fetchImpl, kind] of cases) {
      const error = await new MetaChatModel(config(fetchImpl)).complete(req('hi')).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ModelError);
      expect((error as ModelError).kind).toBe(kind);
      expect((error as ModelError).message).not.toContain('sk-demo-secret');
    }
  });

  it('times out', async () => {
    const hang = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        }),
    );
    const error = await new MetaChatModel(config(hang as unknown as typeof fetch, { timeoutMs: 20 }))
      .complete(req('hi'))
      .catch((e: unknown) => e);
    expect((error as ModelError).kind).toBe('timeout');
  });

  it('refuses contributor models, bad URLs and plain http to a remote host', () => {
    const f = ok({}) as unknown as typeof fetch;
    expect(() => new MetaChatModel(config(f, { model: 'muse-spark-1.3-contributor' }))).toThrow(/Contributor/);
    expect(() => new MetaChatModel(config(f, { baseUrl: 'not a url' }))).toThrow(ModelError);
    expect(() => new MetaChatModel(config(f, { baseUrl: 'http://api.example.test/v1' }))).toThrow(/https/);
    expect(() => new MetaChatModel(config(f, { baseUrl: 'http://127.0.0.1:9/v1' }))).not.toThrow();
  });

  it('reads its configuration from the three META_MODEL_* variables, and is null without a key', () => {
    expect(metaConfigFromEnv({})).toBeNull();
    expect(metaConfigFromEnv({ META_MODEL_API_KEY: 'k' })).toEqual({
      apiKey: 'k',
      baseUrl: 'https://api.meta.ai/v1',
      model: 'muse-spark-1.3',
    });
    expect(
      metaConfigFromEnv({
        META_MODEL_API_KEY: 'k',
        META_MODEL_API_BASE_URL: 'https://x.test/v1',
        META_MODEL_NAME: 'm',
      }),
    ).toEqual({ apiKey: 'k', baseUrl: 'https://x.test/v1', model: 'm' });
  });
});

describe('replay and record', () => {
  const replay = new ReplayChatModel(fixtures);

  it('the shipped fixtures say they are hand-written and DEMO-ONLY', () => {
    expect(fixtures.label).toMatch(/DEMO-ONLY/);
    expect(fixtures.label).toMatch(/Hand-written/);
  });

  it('answers each scenario with the documented shape', async () => {
    expect((await replay.complete(req('Look up order ORD-1001 please'))).toolCalls[0]).toMatchObject({
      ok: true,
      name: 'lookup_order',
      arguments: { order_id: 'ORD-1001' },
    });
    expect((await replay.complete(req('Please export every customer record'))).toolCalls[0]).toMatchObject({
      ok: true,
      name: 'export_customer_data',
    });
    expect((await replay.complete(req('Refund order ORD-2002'))).toolCalls[0]).toMatchObject({
      ok: true,
      name: 'refund_payment',
      arguments: { amount_inr: 9000 },
    });
    expect(await replay.complete(req('what can you do?'))).toMatchObject({
      mode: 'none',
      content: expect.stringContaining('orders') as string,
    });
  });

  it('exercises Mode B, malformed arguments and an unknown tool', async () => {
    expect(await replay.complete(req('email the partner the summary'))).toMatchObject({
      mode: 'prompted-json',
      toolCalls: [{ ok: true, name: 'send_email' }],
    });
    expect((await replay.complete(req('use broken arguments'))).toolCalls[0]).toMatchObject({
      ok: false,
      name: 'lookup_order',
    });
    expect((await replay.complete(req('wipe the database'))).toolCalls[0]).toMatchObject({
      ok: false,
      name: 'delete_database',
    });
  });

  it('a request nothing matches is a replay miss, not a guess', async () => {
    await expect(replay.complete(req('something unrelated'))).rejects.toMatchObject({ kind: 'replay-miss' });
  });

  it('request hashes ignore key order and change when the request changes', () => {
    expect(requestHash(req('a'))).toBe(requestHash(req('a')));
    expect(requestHash(req('a'))).not.toBe(requestHash(req('b')));
    expect(requestHash(req('a'))).not.toBe(requestHash(req('a', { toolMode: 'prompted' })));
  });

  const dir = mkdtempSync(join(tmpdir(), 'replay-'));
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('records a live-style response and replays it by request hash', async () => {
    const path = join(dir, 'recorded.json');
    const body = nativeBody([fn('lookup_order', '{"order_id":"ORD-77"}')]);
    const inner = new MetaChatModel({
      baseUrl: 'https://api.meta.ai/v1',
      apiKey: 'sk-demo-secret-123',
      model: 'muse-spark-1.3',
      fetchImpl: ok(body),
    });
    const recorder = new RecordingChatModel(inner, path);
    const request = req('look up ORD-77 for the record');
    const recorded = await recorder.complete(request);
    const saved = readFileSync(path, 'utf8');
    expect(saved).not.toContain('sk-demo-secret');
    const again = await new ReplayChatModel(loadFixtures(path)).complete(request);
    expect(again.toolCalls).toEqual(recorded.toolCalls);
    await recorder.complete(request); // re-recording the same request replaces the entry
    expect(loadFixtures(path).entries).toHaveLength(1);
  });

  it('rejects a fixture file that is not a fixture file, and a fixture whose response is not a completion', async () => {
    expect(() => loadFixtures(join(dir, 'missing.json'))).toThrow();
    const broken = new ReplayChatModel({
      format: 'prysm-demo-replay',
      version: 1,
      label: 'x',
      entries: [{ id: 'bad', match: { last_user_includes: 'zzz' }, response: { nope: 1 } }],
    });
    await expect(broken.complete(req('zzz'))).rejects.toMatchObject({ kind: 'invalid-response' });
  });
});
