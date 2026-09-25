import { ping, type Pool } from '@prysm/db';
import { baseEnv, createServer, type Logger, type Server } from '@prysm/platform';
import type { Redis } from 'ioredis';
import { z } from 'zod';

/** Environment for the workers process. Queues arrive with their first jobs (M2). */
export const workersEnv = baseEnv.extend({
  DATABASE_URL_APP: z.url(),
  VALKEY_URL: z.url(),
});

export interface WorkersDeps {
  logger: Logger;
  pool: Pool;
  valkey: Redis;
}

/** Builds the workers health server. Ready only when Postgres and Valkey both answer. */
export function buildWorkers({ logger, pool, valkey }: WorkersDeps): Server {
  return createServer({
    logger,
    readiness: [
      { name: 'postgres', check: () => ping(pool) },
      { name: 'valkey', check: () => valkey.ping() },
    ],
  });
}
