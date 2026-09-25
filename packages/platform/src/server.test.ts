import { describe, expect, it } from 'vitest';
import { createServer, requestIdFrom } from './server.ts';
import { captureLogger } from './test-helpers.ts';

describe('requestIdFrom', () => {
  it('keeps safe ids and replaces unsafe or missing ones', () => {
    expect(requestIdFrom('abc-123')).toBe('abc-123');
    expect(requestIdFrom('bad id\n{"level":"fatal"}')).toMatch(/^[0-9a-f-]{36}$/);
    expect(requestIdFrom(['a', 'b'])).toMatch(/^[0-9a-f-]{36}$/);
    expect(requestIdFrom(undefined)).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('createServer', () => {
  it('serves /healthz and echoes the request id', async () => {
    const { app } = createServer({ logger: captureLogger().logger });
    const res = await app.inject({ url: '/healthz', headers: { 'x-request-id': 'req-1' } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-request-id']).toBe('req-1');
  });

  it('logs the route template, never the raw URL or query string', async () => {
    const cap = captureLogger();
    const { app } = createServer({ logger: cap.logger });
    app.get('/items/:id', () => ({ ok: true }));
    await app.inject({ url: '/items/secret-value?token=CANARY', headers: { 'x-request-id': 'req-2' } });
    expect(cap.raw()).not.toContain('CANARY');
    expect(cap.raw()).not.toContain('secret-value');
    expect(cap.lines().at(-1)).toMatchObject({
      event: 'http_request',
      route: '/items/:id',
      status_code: 200,
      request_id: 'req-2',
    });
  });

  it('reports readiness per check and fails closed on errors and timeouts', async () => {
    const { app } = createServer({
      logger: captureLogger().logger,
      readinessTimeoutMs: 50,
      readiness: [
        { name: 'db', check: () => Promise.resolve() },
        { name: 'cache', check: () => Promise.reject(new Error('down')) },
        { name: 'slow', check: () => new Promise((r) => setTimeout(r, 500)) },
      ],
    });
    const res = await app.inject({ url: '/readyz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      status: 'not_ready',
      checks: [
        { name: 'db', ok: true },
        { name: 'cache', ok: false },
        { name: 'slow', ok: false },
      ],
    });
  });

  it('is ready when all checks pass and not ready once shutting down', async () => {
    const server = createServer({
      logger: captureLogger().logger,
      readiness: [{ name: 'db', check: () => Promise.resolve() }],
    });
    expect((await server.app.inject({ url: '/readyz' })).statusCode).toBe(200);
    server.markShuttingDown();
    const res = await server.app.inject({ url: '/readyz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: 'shutting_down' });
  });
});
