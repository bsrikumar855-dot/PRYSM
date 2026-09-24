import { z } from 'zod';

/** Settings every PRYSM Node service reads from its environment. Extend it with `.extend({...})`. */
export const baseEnv = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  SERVICE_NAME: z.string().min(1),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  /** Time to keep serving after readiness turns false, so load balancers stop routing first. */
  SHUTDOWN_DRAIN_DELAY_MS: z.coerce.number().int().min(0).default(0),
});

/**
 * Parses `env` against `schema`. Throws with every problem listed, so a misconfigured
 * service refuses to start instead of running half-configured.
 */
export function loadConfig<S extends z.ZodType>(schema: S, env: Record<string, string | undefined> = process.env): z.output<S> {
  const result = schema.safeParse(env);
  if (!result.success) throw new Error(`Invalid configuration:\n${z.prettifyError(result.error)}`);
  return result.data;
}
