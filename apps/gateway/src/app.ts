import { baseEnv, createServer, type Logger, type Server } from '@prysm/platform';
import type { Redis } from 'ioredis';
import { z } from 'zod';

/** Environment for the gateway. Provider proxying and inline policy evaluation arrive in M4. */
export const gatewayEnv = baseEnv.extend({
  VALKEY_URL: z.url(),
});

export interface GatewayDeps {
  logger: Logger;
  valkey: Redis;
}

/** Builds the gateway server. Ready only when Valkey (rate limits, event stream) answers. */
export function buildGateway({ logger, valkey }: GatewayDeps): Server {
  return createServer({ logger, readiness: [{ name: 'valkey', check: () => valkey.ping() }] });
}
