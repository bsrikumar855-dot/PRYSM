import { randomUUID } from 'node:crypto';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { Logger } from './logger.ts';

export interface ReadinessCheck {
  name: string;
  check: () => Promise<unknown>;
}

export interface ServerOptions {
  logger: Logger;
  readiness?: ReadinessCheck[];
  readinessTimeoutMs?: number;
}

export interface Server {
  app: FastifyInstance;
  /** Makes `/readyz` return 503 from now on. Called first during shutdown. */
  markShuttingDown: () => void;
}

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Accepts a caller's `x-request-id` only if it is short and log-safe; otherwise mints one. */
export function requestIdFrom(header: string | string[] | undefined): string {
  return typeof header === 'string' && REQUEST_ID.test(header) ? header : randomUUID();
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out after ${String(ms)} ms`));
    }, ms);
    promise.then(resolve, reject).finally(() => {
      clearTimeout(timer);
    });
  });
}

/**
 * Fastify instance with PRYSM defaults: request-id propagation, one allow-listed log line per
 * request (route template, never the raw URL), `/healthz` (liveness) and `/readyz` (readiness).
 */
export function createServer({ logger, readiness = [], readinessTimeoutMs = 2_000 }: ServerOptions): Server {
  const baseLogger: FastifyBaseLogger = logger;
  const app = Fastify({
    loggerInstance: baseLogger,
    logController: new LogController({ disableRequestLogging: true, requestIdLogLabel: 'request_id' }),
    genReqId: (req) => requestIdFrom(req.headers['x-request-id']),
  });
  let shuttingDown = false;

  // Callback style on purpose: a Fastify reply is thenable, so awaiting reply.header() would wait for the response.
  app.addHook('onRequest', (req, reply, done) => {
    reply.header('x-request-id', req.id);
    done();
  });
  app.addHook('onResponse', async (req, reply) => {
    req.log.info(
      {
        event: 'http_request',
        method: req.method,
        route: req.routeOptions.url ?? 'unmatched',
        status_code: reply.statusCode,
        duration_ms: Math.round(reply.elapsedTime),
      },
      'request completed',
    );
  });

  app.get('/healthz', () => ({ status: 'ok' }));
  app.get('/readyz', async (req, reply) => {
    if (shuttingDown) return reply.code(503).send({ status: 'shutting_down', checks: [] });
    const checks = await Promise.all(
      readiness.map(async ({ name, check }) => {
        try {
          await withTimeout(check(), readinessTimeoutMs);
          return { name, ok: true };
        } catch (err) {
          req.log.warn({ event: 'readiness_failed', check: name, err }, 'readiness check failed');
          return { name, ok: false };
        }
      }),
    );
    const ok = checks.every((c) => c.ok);
    return reply.code(ok ? 200 : 503).send({ status: ok ? 'ready' : 'not_ready', checks });
  });

  return {
    app,
    markShuttingDown: () => {
      shuttingDown = true;
    },
  };
}
