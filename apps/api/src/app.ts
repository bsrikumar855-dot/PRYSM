import { ping, type Pool } from '@prysm/db';
import { baseEnv, createServer, type Logger, type Server } from '@prysm/platform';
import type { Redis } from 'ioredis';
import { z } from 'zod';

/** Environment for the API service. */
export const apiEnv = baseEnv.extend({
  DATABASE_URL_APP: z.url(),
  VALKEY_URL: z.url(),
});

export interface ApiDeps {
  logger: Logger;
  pool: Pool;
  valkey: Redis;
}

/** Builds the API server. Ready only when Postgres and Valkey both answer. Routes arrive in M1. */
export function buildApi({ logger, pool, valkey }: ApiDeps): Server {
  return createServer({
    logger,
    readiness: [
      { name: 'postgres', check: () => ping(pool) },
      { name: 'valkey', check: () => valkey.ping() },
    ],
  });
}
