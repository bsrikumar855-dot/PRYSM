import { readFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type pg from 'pg';
import { demoDeleteRow, demoFullRewrite, demoReset, demoTamperEdit } from '../evidence/store.ts';
import { decideSchema, tamperSchema } from './schemas.ts';
import { handleChat, cleanActor, type PipelineContext } from './pipeline.ts';

// DEMO-ONLY (TODO(T-001), TODO(T-003)). The demo server: the gateway route, the dashboard's data endpoints and the
// static dashboard page. It binds to loopback, checks the Host header (DNS rebinding), requires JSON bodies, and for
// the dashboard's mutating endpoints a custom header, so a web page on another site cannot drive it. There is no login.

export interface ServerContext extends PipelineContext {
  /** Connection that uses the table OWNER role. DEMO-ONLY: only the tamper and reset endpoints use it. */
  admin: pg.Pool | null;
  anchorPath: string;
  webRoot: string;
  mode: string;
  port: () => number;
}

const MAX_BODY = 256 * 1024;

const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const SECURITY_HEADERS = {
  'content-security-policy': CSP,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
  'cross-origin-resource-policy': 'same-origin',
  'x-frame-options': 'DENY',
};

const STATIC: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
};

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(\s*;|$)/i.test(req.headers['content-type'] ?? ''))
    throw new HttpError(415, 'Send application/json.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY) throw new HttpError(413, 'The request body is too large.');
    chunks.push(buf);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new HttpError(400, 'The request body is not valid JSON.');
  }
}

/** Safe JSON line for the server's own log: event names and ids only, never a payload. */
function log(event: string, fields: Record<string, string | number | boolean> = {}): void {
  process.stdout.write(`${JSON.stringify({ level: 'info', component: 'demo-gateway', event, ...fields })}\n`);
}

export function createGatewayServer(ctx: ServerContext): { server: Server; close: () => Promise<void> } {
  const requireDemoHeader = (req: IncomingMessage): void => {
    if (req.headers['x-demo-action'] !== '1') throw new HttpError(403, 'Missing the x-demo-action header.');
    const origin = req.headers['origin'];
    if (origin !== undefined && !allowedHosts().has(new URL(origin).host))
      throw new HttpError(403, 'Cross-site request refused.');
  };
  const allowedHosts = (): Set<string> =>
    new Set([`127.0.0.1:${String(ctx.port())}`, `localhost:${String(ctx.port())}`]);

  const state = async () => ({
    mode: ctx.mode,
    model: ctx.model.name,
    policy: { name: ctx.policy.policy.name ?? '', hash: ctx.policy.hash, rule_count: ctx.policy.policy.rules.length },
    verify: await ctx.ledger.refresh(),
    approvals: ctx.approvals.list(),
    tamper_enabled: ctx.admin !== null,
  });

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const host = req.headers['host'];
        if (!host || !allowedHosts().has(host)) throw new HttpError(421, 'Unexpected Host header.');
        const url = new URL(req.url ?? '/', `http://${host}`);
        const method = req.method ?? 'GET';

        const asset = method === 'GET' ? STATIC[url.pathname] : undefined;
        if (asset) {
          const text = await readFile(`${ctx.webRoot}/${asset.file}`);
          res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': asset.type, 'content-length': text.length });
          res.end(text);
          return;
        }

        if (method === 'POST' && url.pathname === '/v1/chat/completions') {
          const out = await handleChat(ctx, await readJson(req));
          send(res, out.status, out.body);
          return;
        }
        if (method === 'GET' && url.pathname === '/demo/events') {
          const recent = await ctx.ledger.recent(60);
          ctx.hub.subscribe(res, [
            { event: 'state', data: await state() },
            ...recent.map((r) => ({ event: 'record', data: r })),
            { event: 'approvals', data: { pending: ctx.approvals.list() } },
          ]);
          return;
        }
        if (method === 'GET' && url.pathname === '/demo/state') {
          send(res, 200, await state());
          return;
        }
        if (method === 'GET' && url.pathname === '/demo/verify') {
          send(res, 200, await ctx.ledger.refresh());
          return;
        }
        if (method === 'GET' && url.pathname === '/demo/approvals') {
          send(res, 200, { pending: ctx.approvals.list() });
          return;
        }

        const decide = /^\/demo\/approvals\/([0-9a-f-]{36})$/.exec(url.pathname);
        if (method === 'POST' && decide) {
          requireDemoHeader(req);
          const body = decideSchema.safeParse(await readJson(req));
          if (!body.success) throw new HttpError(400, 'Send {"decision":"approve"|"deny","actor":"<your name>"}.');
          const info = ctx.approvals.decide(
            decide[1] ?? '',
            body.data.decision === 'approve' ? 'approved' : 'denied',
            cleanActor(body.data.actor),
          );
          if (!info) throw new HttpError(404, 'That approval is not pending.');
          send(res, 200, { ok: true, approval_id: info.id });
          return;
        }

        if (method === 'POST' && url.pathname === '/demo/tamper') {
          requireDemoHeader(req);
          if (!ctx.admin) throw new HttpError(403, 'Tampering is not enabled.');
          const body = tamperSchema.safeParse(await readJson(req));
          if (!body.success) throw new HttpError(400, 'Send {"action":"edit"|"rewrite"|"delete","seq":<number>}.');
          await ctx.ledger.idle();
          if (body.data.action === 'edit') await demoTamperEdit(ctx.admin, body.data.seq);
          else if (body.data.action === 'rewrite') await demoFullRewrite(ctx.admin, body.data.seq);
          else await demoDeleteRow(ctx.admin, body.data.seq);
          log('demo_tamper', { action: body.data.action, seq: body.data.seq });
          send(res, 200, { ok: true, verify: await ctx.ledger.refresh() });
          return;
        }
        if (method === 'POST' && url.pathname === '/demo/reset') {
          requireDemoHeader(req);
          if (!ctx.admin) throw new HttpError(403, 'Reset is not enabled.');
          await ctx.ledger.idle();
          await demoReset(ctx.admin);
          rmSync(ctx.anchorPath, { force: true });
          await ctx.ledger.record('policy.loaded', 'demo:reset', {
            policy_hash: ctx.policy.hash,
            policy_name: ctx.policy.policy.name ?? '',
            rule_count: ctx.policy.policy.rules.length,
          });
          log('demo_reset');
          send(res, 200, { ok: true, state: await state() });
          return;
        }

        throw new HttpError(404, 'Not found.');
      } catch (e) {
        if (res.headersSent) return void res.end();
        if (e instanceof HttpError) {
          send(res, e.status, { error: { code: 'refused', message: e.message } });
          return;
        }
        log('unhandled_error', { name: e instanceof Error ? e.name : 'unknown' });
        send(res, 500, { error: { code: 'internal', message: 'Something went wrong. Nothing was approved.' } });
      }
    })();
  });

  return {
    server,
    close: async () => {
      ctx.hub.close();
      await ctx.ledger.idle();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      });
    },
  };
}
