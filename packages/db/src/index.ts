import pg from 'pg';

export type { Pool, PoolClient } from 'pg';

export { findRlsGaps, type RlsGap } from './rls-coverage.ts';

export interface PoolOptions {
  connectionString: string;
  /** Shows up in pg_stat_activity, e.g. "prysm-api". */
  applicationName: string;
  max?: number;
  /** Server-side cap per statement, so a runaway query can't hold a connection forever. */
  statementTimeoutMs?: number;
}

/** A pg connection pool with PRYSM defaults. */
export function createPool({
  connectionString,
  applicationName,
  max = 10,
  statementTimeoutMs = 15_000,
}: PoolOptions): pg.Pool {
  return new pg.Pool({
    connectionString,
    application_name: applicationName,
    max,
    statement_timeout: statementTimeoutMs,
    connectionTimeoutMillis: 5_000,
  });
}

/** Readiness probe: one round trip. */
export async function ping(pool: pg.Pool): Promise<void> {
  await pool.query('SELECT 1');
}
