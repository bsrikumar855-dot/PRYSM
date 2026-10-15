import pg from 'pg';

export interface PoolOptions {
  connectionString: string;
  /** Shows up in pg_stat_activity, e.g. "prysm-api". */
  applicationName: string;
  max?: number;
  /** Server-side cap per statement, so a runaway query can't hold a connection forever. */
  statementTimeoutMs?: number;
  /** Server-side cap on a transaction that sits idle, so a stuck handler can't pin a pooled connection. */
  idleInTransactionTimeoutMs?: number;
}

/** A pg connection pool with PRYSM defaults. Internal to `packages/db`: services get a `Db`, never the pool. */
export function createPool({
  connectionString,
  applicationName,
  max = 10,
  statementTimeoutMs = 15_000,
  idleInTransactionTimeoutMs = 30_000,
}: PoolOptions): pg.Pool {
  return new pg.Pool({
    connectionString,
    application_name: applicationName,
    max,
    statement_timeout: statementTimeoutMs,
    idle_in_transaction_session_timeout: idleInTransactionTimeoutMs,
    connectionTimeoutMillis: 5_000,
  });
}

/** Readiness probe: one round trip. */
export async function ping(pool: pg.Pool): Promise<void> {
  await pool.query('SELECT 1');
}
