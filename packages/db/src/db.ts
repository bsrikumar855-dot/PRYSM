import type pg from 'pg';
import { createPool, ping, type PoolOptions } from './pool.ts';

/** Result of a query run inside `withTenant`. */
export interface TenantQueryResult<R> {
  rows: R[];
  rowCount: number | null;
}

/**
 * The only way to read or write tenant data: a client bound to one transaction whose
 * `app.tenant_id` is set, so Postgres RLS (ADR-0007) confines every statement to that tenant.
 * It stops working the moment `withTenant` returns.
 */
export interface TenantTx {
  query<R extends object = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<TenantQueryResult<R>>;
}

/** What services hold instead of a connection pool (ADR-0003, ADR-0007). */
export interface Db {
  /**
   * Runs `fn` in a transaction scoped to `tenantId`: `BEGIN`, `set_config('app.tenant_id', id, true)`, `fn`,
   * then `COMMIT` (or `ROLLBACK` if `fn` throws). The setting is transaction-local, so it is safe with
   * PgBouncer transaction pooling and can't outlive the call. `tenantId` must come from the authenticated
   * principal, never from a request body, path or header.
   */
  withTenant<T>(tenantId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T>;
  /** Readiness probe. Touches no tenant data, so it needs no tenant. */
  ping(): Promise<void>;
  /** Closes the pool. */
  end(): Promise<void>;
}

export type DbOptions = PoolOptions;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Throws unless `tenantId` is a UUID; checked before any connection is taken. */
function assertTenantId(tenantId: unknown): asserts tenantId is string {
  if (typeof tenantId !== 'string' || !UUID.test(tenantId)) throw new TypeError('tenantId must be a UUID');
}

/** Builds a `Db` over an existing pool. Exported only inside the package, for tests that need to inspect the pool. */
export function createDbOnPool(pool: pg.Pool): Db {
  return {
    async withTenant<T>(tenantId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
      assertTenantId(tenantId);
      const client = await pool.connect();
      let open = true;
      const run = async (text: string, values?: readonly unknown[]): Promise<TenantQueryResult<pg.QueryResultRow>> => {
        if (!open) throw new Error('This transaction has ended; a TenantTx must not be used after withTenant returns');
        const result = await client.query<pg.QueryResultRow>(text, values ? [...values] : undefined);
        return { rows: result.rows, rowCount: result.rowCount };
      };
      // The cast only supplies the caller's row type, which pg can't know; the rows are whatever Postgres returned.
      const tx: TenantTx = { query: run as TenantTx['query'] };
      let destroy: Error | undefined;
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
        const result = await fn(tx);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          // The connection state is unknown; don't hand it back to the pool.
          destroy = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
        }
        throw error;
      } finally {
        open = false;
        client.release(destroy);
      }
    },
    ping: () => ping(pool),
    end: () => pool.end(),
  };
}

/** Creates a `Db` with its own pool. */
export function createDb(options: DbOptions): Db {
  return createDbOnPool(createPool(options));
}
