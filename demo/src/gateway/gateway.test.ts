/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return --
   DEMO-ONLY test file: HTTP response bodies are untyped JSON that each test asserts field by field. */
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@prysm/db/testing';
import {
  ReplayChatModel,
  ModelError,
  loadFixtures,
  type ChatModel,
  type ChatRequest,
  type ChatResult,
} from '../adapter/index.ts';
import { DEMO_TOOLS } from '../adapter/tools.ts';
import { applyEvidenceMigration } from '../db/migrate.ts';
import { readAnchor } from '../evidence/anchor.ts';
import { demoReset, readChain } from '../evidence/store.ts';
import { verifyChain } from '../evidence/chain.ts';
import { parsePolicyYaml } from '../policy/index.ts';
import { readFileSync } from 'node:fs';
import { ApprovalBroker } from './approvals.ts';
import { EventHub } from './events.ts';
import { Ledger } from './ledger.ts';
import { createGatewayServer } from './server.ts';

// End-to-end through real HTTP: the gateway route, the policy, the approval wait, the evidence log and the
// anchor, against a throwaway database. The model is the replay model with the shipped hand-written fixtures.
const ROOT = new URL('../../', import.meta.url).pathname;
const policy = parsePolicyYaml(readFileSync(`${ROOT}policies/demo-policy.yaml`, 'utf8'));
const fixtures = loadFixtures(`${ROOT}fixtures/replay.json`);

let testDb: TestDatabase;
let db: pg.Pool;
let admin: pg.Pool;
let dir = '';
let anchorPath = '';
let server: Server;
let close: () => Promise<void>;
let base = '';
let hub: EventHub;
let ledger: Ledger;
let seenByModel: ChatRequest[] = [];
let approvalTimeoutMs = 5_000;
let modelOverride: ChatModel | null = null;

const spy: ChatModel = {
  name: 'replay',
  complete(request: ChatRequest): Promise<ChatResult> {
    seenByModel.push(request);
    return (modelOverride ?? new ReplayChatModel(fixtures)).complete(request);
  },
};

const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any>, headers: res.headers };
};
const chat = (user: string) => post('/v1/chat/completions', { messages: [{ role: 'user', content: user }] });
const demoHeaders = { 'x-demo-action': '1' };

async function types(): Promise<string[]> {
  await ledger.idle();
  return (await readChain(db)).map((r) => (JSON.parse(r.canonical) as { type: string }).type);
}
async function docs(): Promise<{ type: string; actor: string; data: Record<string, any> }[]> {
  await ledger.idle();
  return (await readChain(db)).map(
    (r) => JSON.parse(r.canonical) as { type: string; actor: string; data: Record<string, any> },
  );
}

beforeAll(async () => {
  testDb = await createTestDatabase({ suite: 'demo_gateway' });
  const owner = new pg.Pool({ connectionString: testDb.ownerUrl, max: 3 });
  db = new pg.Pool({ connectionString: testDb.appUrl, max: 8 });
  admin = owner;
  const c = await owner.connect();
  try {
    await applyEvidenceMigration(c, 'prysm_app');
  } finally {
    c.release();
  }
  dir = mkdtempSync(join(tmpdir(), 'demo-gateway-'));
  anchorPath = join(dir, 'anchor.json');
  hub = new EventHub();
  ledger = new Ledger(db, anchorPath, hub, () => new Date('2026-10-28T10:00:00Z'));
  let listening = 0;
  const made = createGatewayServer({
    model: spy,
    policy,
    ledger,
    approvals: new ApprovalBroker(),
    hub,
    db,
    admin,
    anchorPath,
    webRoot: `${ROOT}web`,
    mode: 'replay',
    port: () => listening,
    defaultTools: DEMO_TOOLS,
    get approvalTimeoutMs() {
      return approvalTimeoutMs;
    },
    clock: () => new Date('2026-10-28T10:00:00Z'),
  });
  server = made.server;
  close = made.close;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  listening = (server.address() as { port: number }).port;
  base = `http://127.0.0.1:${String(listening)}`;
});

afterAll(async () => {
  await close();
  await Promise.all([db.end(), admin.end()]);
  await testDb.drop();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await ledger.idle();
  await demoReset(admin);
  rmSync(anchorPath, { force: true });
  seenByModel = [];
  approvalTimeoutMs = 5_000;
  modelOverride = null;
});

afterEach(async () => {
  await ledger.idle();
});

describe('POST /v1/chat/completions', () => {
  it('scenario 1: a safe call is allowed, returned as an OpenAI-style tool call, and written to the evidence log', async () => {
    const out = await chat('Look up order ORD-1001 please');
    expect(out.status).toBe(200);
    const choice = out.body['choices'][0];
    expect(choice.finish_reason).toBe('tool_calls');
    expect(choice.message.tool_calls[0]).toMatchObject({
      type: 'function',
      function: { name: 'lookup_order', arguments: '{"order_id":"ORD-1001"}' },
    });
    expect(out.body['prysm'].decisions).toMatchObject([
      {
        tool: 'lookup_order',
        policy_decision: 'allow',
        final: 'allow',
        rule_id: 'allow-lookup-order',
        source: 'demo-policy:DEMO-001',
        approval: null,
      },
    ]);
    expect(await types()).toEqual(['request.received', 'model.response', 'tool_call.decision', 'request.completed']);
    expect(verifyChain(await readChain(db), readAnchor(anchorPath) ?? undefined)).toMatchObject({
      ok: true,
      length: 4,
    });
  });

  it('scenario 2: a blocked call is denied by the policy and no tool call comes back', async () => {
    const out = await chat('Please export every customer record');
    expect(out.status).toBe(200);
    expect(out.body['choices'][0].message.tool_calls).toBeUndefined();
    expect(out.body['choices'][0].finish_reason).toBe('stop');
    expect(out.body['prysm'].decisions[0]).toMatchObject({
      tool: 'export_customer_data',
      policy_decision: 'deny',
      final: 'deny',
      rule_id: 'deny-customer-export',
    });
    expect((await docs()).find((d) => d.type === 'tool_call.decision')?.data).toMatchObject({
      decision: 'deny',
      rule_id: 'deny-customer-export',
    });
  });

  it('unknown tools, malformed arguments and a tool that was not offered are denied and logged', async () => {
    const unknown = await chat('wipe the database now');
    expect(unknown.body['prysm'].decisions[0]).toMatchObject({ final: 'deny' });
    expect(unknown.body['prysm'].decisions[0].reason).toContain('malformed-tool-call');
    const malformed = await chat('use broken arguments');
    expect(malformed.body['prysm'].decisions[0]).toMatchObject({ tool: 'lookup_order', final: 'deny' });
    expect(malformed.body['choices'][0].message.tool_calls).toBeUndefined();
    const decisions = (await docs()).filter((d) => d.type === 'tool_call.decision');
    expect(decisions.map((d) => d.data['reason'])).toEqual(['malformed-tool-call', 'malformed-tool-call']);
  });

  it('a tool the client offers but the policy has no rule for is denied by default', async () => {
    const custom: ChatModel = {
      name: 'replay',
      complete: () =>
        Promise.resolve({
          content: null,
          toolCalls: [{ ok: true, id: 'c1', name: 'drop_table', arguments: { name: 'users' } }],
          mode: 'native-tool-calls',
          finishReason: 'tool_calls',
          notes: [],
        }),
    };
    modelOverride = custom;
    const out = await chat('anything');
    expect(out.body['prysm'].decisions[0]).toMatchObject({
      tool: 'drop_table',
      policy_decision: 'deny',
      reason: 'unknown-tool',
      final: 'deny',
    });
  });

  it('Mode B: a JSON tool request in the text still goes through the policy (external email needs approval)', async () => {
    approvalTimeoutMs = 50;
    const out = await chat('email the partner the summary');
    expect(out.body['prysm'].decisions[0]).toMatchObject({
      tool: 'send_email',
      policy_decision: 'require_approval',
      final: 'deny',
    });
    expect((await docs()).find((d) => d.type === 'model.response')?.data['mode']).toBe('prompted-json');
  });

  it('a model failure returns 502, is logged as evidence, and approves nothing', async () => {
    const out = await chat('something no fixture matches');
    expect(out.status).toBe(502);
    expect(out.body['error'].code).toBe('model_unavailable');
    expect(await types()).toEqual(['request.received', 'model.error']);
    expect((await docs())[1]?.data).toEqual({ request_id: expect.any(String), kind: 'replay-miss' });
  });

  it('rejects bad bodies, streaming, wrong content types and oversized bodies', async () => {
    expect((await post('/v1/chat/completions', { messages: [] })).status).toBe(400);
    expect(
      (await post('/v1/chat/completions', { messages: [{ role: 'user', content: 'x' }], stream: true })).status,
    ).toBe(400);
    const wrongType = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{}',
    });
    expect(wrongType.status).toBe(415);
    const bad = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{nope',
    });
    expect(bad.status).toBe(400);
    const big = await post('/v1/chat/completions', { messages: [{ role: 'user', content: 'x'.repeat(300_000) }] });
    expect([400, 413]).toContain(big.status);
    expect(await types()).toEqual([]);
  });
});

describe('redaction', () => {
  const email = 'priya.nair@example.test';
  const pan = 'ABCPE1234F';
  const phone = '+91 98765 43210';

  it('the model and the evidence log never see raw PII, and the response reports counts only', async () => {
    const out = await chat(`Look up order ORD-1001 for ${email}, PAN ${pan}, phone ${phone}`);
    const sent = JSON.stringify(seenByModel);
    for (const pii of [email, pan, phone, '98765 43210']) expect(sent).not.toContain(pii);
    expect(sent).toContain('[REDACTED:EMAIL]');
    const everything = JSON.stringify(await docs()) + JSON.stringify(out.body);
    for (const pii of [email, pan, phone, '98765 43210']) expect(everything).not.toContain(pii);
    expect(out.body['prysm'].redaction).toEqual({ aadhaar: 0, pan: 1, email: 1, phone: 1 });
    expect((await docs())[0]?.data).toMatchObject({
      redaction_total: 3,
      redaction_counts: { pan: 1, email: 1, phone: 1, aadhaar: 0 },
    });
  });

  it('PII in a tool call the model proposes is redacted before the policy and before the log', async () => {
    modelOverride = {
      name: 'replay',
      complete: () =>
        Promise.resolve({
          content: `Contact ${email}`,
          toolCalls: [
            { ok: true, id: 'c1', name: 'send_email', arguments: { audience: 'internal', subject: `for ${email}` } },
          ],
          mode: 'native-tool-calls',
          finishReason: 'tool_calls',
          notes: [],
        }),
    };
    const out = await chat('send a note');
    const everything = JSON.stringify(await docs()) + JSON.stringify(out.body);
    expect(everything).not.toContain(email);
    expect(out.body['choices'][0].message.content).toBe('Contact [REDACTED:EMAIL]');
    expect(out.body['choices'][0].message.tool_calls[0].function.arguments).toContain('[REDACTED:EMAIL]');
  });
});

describe('scenario 3: approval', () => {
  async function pendingId(): Promise<string> {
    for (let i = 0; i < 100; i += 1) {
      const res = await fetch(`${base}/demo/approvals`);
      const body = (await res.json()) as { pending: { id: string; tool: string }[] };
      if (body.pending[0]) return body.pending[0].id;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('no approval became pending');
  }

  it('pauses until a human approves, then returns the tool call; the approval and the actor are evidence', async () => {
    const waiting = chat('Refund order ORD-2002');
    const id = await pendingId();
    const settledEarly = await Promise.race([
      waiting.then(() => true),
      new Promise<boolean>((r) =>
        setTimeout(() => {
          r(false);
        }, 150),
      ),
    ]);
    expect(settledEarly).toBe(false); // really paused
    const decided = await post(`/demo/approvals/${id}`, { decision: 'approve', actor: 'asha.verma' }, demoHeaders);
    expect(decided.status).toBe(200);
    const out = await waiting;
    expect(out.body['prysm'].decisions[0]).toMatchObject({
      tool: 'refund_payment',
      policy_decision: 'require_approval',
      final: 'allow',
      approval: { id, outcome: 'approved', actor: 'asha.verma' },
    });
    expect(out.body['choices'][0].message.tool_calls[0].function.name).toBe('refund_payment');
    const all = await docs();
    expect(all.map((d) => d.type)).toEqual([
      'request.received',
      'model.response',
      'tool_call.decision',
      'approval.requested',
      'approval.resolved',
      'request.completed',
    ]);
    expect(all.find((d) => d.type === 'approval.resolved')).toMatchObject({
      actor: 'asha.verma',
      data: { approval_id: id, outcome: 'approved', decided_by: 'human' },
    });
    expect(verifyChain(await readChain(db), readAnchor(anchorPath) ?? undefined).ok).toBe(true);
  });

  it('a denial returns no tool call and records who denied it', async () => {
    const waiting = chat('Refund order ORD-2002');
    const id = await pendingId();
    await post(`/demo/approvals/${id}`, { decision: 'deny', actor: 'ravi' }, demoHeaders);
    const out = await waiting;
    expect(out.body['choices'][0].message.tool_calls).toBeUndefined();
    expect(out.body['prysm'].decisions[0]).toMatchObject({
      final: 'deny',
      approval: { outcome: 'denied', actor: 'ravi' },
    });
    expect((await docs()).find((d) => d.type === 'approval.resolved')?.actor).toBe('ravi');
  });

  it('no decision before the timeout counts as a denial and says so', async () => {
    approvalTimeoutMs = 60;
    const out = await chat('Refund order ORD-2002');
    expect(out.body['prysm'].decisions[0]).toMatchObject({ final: 'deny', approval: { outcome: 'timeout' } });
    expect((await docs()).find((d) => d.type === 'approval.resolved')?.data).toMatchObject({
      outcome: 'timeout',
      decided_by: 'timeout',
    });
  });

  it('an approver label that is an email address is redacted before it is stored', async () => {
    const waiting = chat('Refund order ORD-2002');
    const id = await pendingId();
    const res = await post(
      `/demo/approvals/${id}`,
      { decision: 'approve', actor: 'asha@corp.example.test' },
      demoHeaders,
    );
    expect(res.status).toBe(200);
    const out = await waiting;
    expect(out.body['prysm'].decisions[0].approval.actor).toBe('[REDACTED:EMAIL]');
    const all = JSON.stringify(await docs()) + JSON.stringify(out.body);
    expect(all).not.toContain('asha@corp.example.test');
  });

  it('refuses an approver label with characters outside the allowed set', async () => {
    const waiting = chat('Refund order ORD-2002');
    const id = await pendingId();
    expect((await post(`/demo/approvals/${id}`, { decision: 'approve', actor: '<script>' }, demoHeaders)).status).toBe(
      400,
    );
    expect((await post(`/demo/approvals/${id}`, { decision: 'approve', actor: '' }, demoHeaders)).status).toBe(400);
    await post(`/demo/approvals/${id}`, { decision: 'deny', actor: 'AB' }, demoHeaders);
    await waiting;
  });

  it('deciding twice or deciding an unknown approval is refused', async () => {
    expect(
      (
        await post(
          '/demo/approvals/00000000-0000-4000-8000-000000000000',
          { decision: 'approve', actor: 'x' },
          demoHeaders,
        )
      ).status,
    ).toBe(404);
    const waiting = chat('Refund order ORD-2002');
    const id = await pendingId();
    expect((await post(`/demo/approvals/${id}`, { decision: 'approve', actor: 'x' }, demoHeaders)).status).toBe(200);
    expect((await post(`/demo/approvals/${id}`, { decision: 'deny', actor: 'y' }, demoHeaders)).status).toBe(404);
    await waiting;
  });
});

describe('dashboard endpoints and request hygiene', () => {
  it('serves the static dashboard with a strict CSP and no inline script', async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await fetch(`${base}/app.js`)).status).toBe(200);
    expect((await fetch(`${base}/missing.js`)).status).toBe(404);
    expect((await fetch(`${base}/../package.json`)).status).toBe(404);
  });

  it('refuses a wrong Host header (DNS rebinding) and cross-site or header-less mutating requests', async () => {
    const wrongHost = await new Promise<number>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port: new URL(base).port, path: '/demo/state', headers: { host: 'evil.example.test' } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(wrongHost).toBe(421);
    expect((await post('/demo/tamper', { action: 'edit', seq: 0 })).status).toBe(403);
    expect((await post('/demo/reset', {}, { 'x-demo-action': '1', origin: 'https://evil.example.test' })).status).toBe(
      403,
    );
    expect(
      (await post('/demo/approvals/00000000-0000-4000-8000-000000000000', { decision: 'approve', actor: 'x' })).status,
    ).toBe(403);
  });

  it('streams evidence records over server-sent events', async () => {
    await chat('Look up order ORD-1001');
    const controller = new AbortController();
    const res = await fetch(`${base}/demo/events`, { signal: controller.signal });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    let text = '';
    const deadline = Date.now() + 3_000;
    while (!text.includes('request.completed') && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    controller.abort();
    expect(text).toContain('event: state');
    expect(text).toContain('event: record');
    expect(text).toContain('tool_call.decision');
  });

  it('live events arrive while connected', async () => {
    const controller = new AbortController();
    const res = await fetch(`${base}/demo/events`, { signal: controller.signal });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    await reader.read(); // hello frames
    void chat('Look up order ORD-1001');
    let text = '';
    const deadline = Date.now() + 3_000;
    while (!text.includes('request.completed') && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    controller.abort();
    expect(text).toContain('request.received');
  });
});

describe('tamper and verification through the server (DEMO-ONLY)', () => {
  const state = async () => (await (await fetch(`${base}/demo/state`)).json()) as Record<string, any>;

  it('starts verified; editing a row fails verification at that index; reset restores a clean chain', async () => {
    await chat('Look up order ORD-1001');
    await ledger.idle();
    expect((await state())['verify'].result).toMatchObject({ ok: true });
    const tamper = await post('/demo/tamper', { action: 'edit', seq: 2 }, demoHeaders);
    expect(tamper.status).toBe(200);
    expect(tamper.body['verify'].result).toMatchObject({ ok: false, index: 2, reason: 'hash-mismatch' });
    expect((await state())['verify'].result).toMatchObject({ ok: false, index: 2 });
    const reset = await post('/demo/reset', {}, demoHeaders);
    expect(reset.status).toBe(200);
    expect(reset.body['state'].verify.result).toMatchObject({ ok: true, length: 1 });
    expect(existsSync(anchorPath)).toBe(true);
  });

  it('a full rewrite passes the chain check and is caught by the anchor, which the rewritten chain cannot move', async () => {
    await chat('Look up order ORD-1001');
    await ledger.idle();
    const anchorBefore = readAnchor(anchorPath);
    const rewrite = await post('/demo/tamper', { action: 'rewrite', seq: 2 }, demoHeaders);
    expect(rewrite.body['verify'].result).toMatchObject({ ok: false, reason: 'anchor-mismatch' });
    expect(readAnchor(anchorPath)).toEqual(anchorBefore);
    // new evidence after the rewrite does not repair the anchor either
    await chat('Look up order ORD-1001');
    await ledger.idle();
    expect(readAnchor(anchorPath)).toEqual(anchorBefore);
    expect((await state())['verify'].result).toMatchObject({ ok: false });
  });

  it('a deleted row shows as a gap at its index', async () => {
    await chat('Look up order ORD-1001');
    await ledger.idle();
    const out = await post('/demo/tamper', { action: 'delete', seq: 1 }, demoHeaders);
    expect(out.body['verify'].result).toMatchObject({ ok: false, index: 1, reason: 'gap' });
  });

  it('validates tamper requests', async () => {
    expect((await post('/demo/tamper', { action: 'nuke', seq: 1 }, demoHeaders)).status).toBe(400);
    expect((await post('/demo/tamper', { action: 'edit', seq: 999 }, demoHeaders)).status).toBe(500);
  });
});

describe('model errors surface their kind only', () => {
  it('maps ModelError kinds into evidence without any message text', async () => {
    modelOverride = {
      name: 'x',
      complete: () => Promise.reject(new ModelError('timeout', 'secret-ish detail that must not be stored')),
    };
    const out = await chat('hello');
    expect(out.status).toBe(502);
    expect(JSON.stringify(await docs())).not.toContain('secret-ish');
  });
});
