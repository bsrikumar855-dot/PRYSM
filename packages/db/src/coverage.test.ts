import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from './pool.ts';
import { findRlsGaps, findTenancyProblems } from './rls-coverage.ts';
import { GLOBAL_TABLES, TENANT_ROOT_TABLE, TENANT_TABLES } from './tables.ts';
import { createTestDatabase, type TestDatabase } from './testing/index.ts';

// ADR-0007 tests 1 and ADR-0013 tests G1 to G3: every table is either a tenant table with FORCE RLS and a
// complete policy, or on the explicit global allowlist, and the two sets are checked in both directions.
let testDb: TestDatabase;
let owner: pg.Pool;

beforeAll(async () => {
  testDb = await createTestDatabase({ suite: 'coverage' });
  owner = createPool({ connectionString: testDb.ownerUrl, applicationName: 'prysm-coverage-test' });
});

afterAll(async () => {
  await owner.end();
  await testDb.drop();
});

/** Runs `fn` against the clone inside a transaction that is always rolled back. */
async function planted<T>(setup: string, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    if (setup) await client.query(setup);
    return await fn(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

describe('RLS coverage on the migrated schema', () => {
  it('every tenant table has RLS enabled and forced and a complete policy', async () => {
    expect(await findRlsGaps(owner)).toEqual([]);
  });

  it('the tenant tables in code match the catalog exactly (no table can hide from withGlobal)', async () => {
    const { rows } = await owner.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relrowsecurity ORDER BY 1`,
    );
    expect(rows.map((r) => r.relname)).toEqual([...TENANT_TABLES].sort());
  });

  it('every tenant table has tenant_id, except tenants, which is keyed by id', async () => {
    for (const table of TENANT_TABLES) {
      const { rows } = await owner.query<{ n: string }>(
        `SELECT count(*) AS n FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'tenant_id'`,
        [table],
      );
      expect(Number(rows[0]?.n), table).toBe(table === TENANT_ROOT_TABLE ? 0 : 1);
    }
  });

  it('every tenant table is keyed or uniquely identified so composite foreign keys can target it', async () => {
    const { rows } = await owner.query<{ relname: string; cols: string[] }>(
      `SELECT c.relname, array_agg(a.attname::text ORDER BY a.attnum) AS cols
         FROM pg_constraint k
         JOIN pg_class c ON c.oid = k.conrelid
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY (k.conkey)
        WHERE k.contype = 'p' AND c.relname = ANY ($1)
        GROUP BY c.relname, k.oid ORDER BY 1`,
      [TENANT_TABLES.filter((t) => t !== TENANT_ROOT_TABLE)],
    );
    for (const { relname, cols } of rows) expect(cols[0], relname).toBe('tenant_id');
    expect(rows.length).toBe(TENANT_TABLES.length - 1);
  });

  it('a foreign key from one tenant table to another tenant table (other than tenants) is composite with tenant_id', async () => {
    const { rows } = await owner.query<{ name: string; cols: string[] }>(
      `SELECT k.conname AS name, array_agg(a.attname::text ORDER BY a.attnum) AS cols
         FROM pg_constraint k
         JOIN pg_class src ON src.oid = k.conrelid
         JOIN pg_class dst ON dst.oid = k.confrelid
         JOIN pg_attribute a ON a.attrelid = src.oid AND a.attnum = ANY (k.conkey)
        WHERE k.contype = 'f' AND src.relname = ANY ($1) AND dst.relname = ANY ($1) AND dst.relname <> $2
        GROUP BY k.oid, k.conname`,
      [TENANT_TABLES, TENANT_ROOT_TABLE],
    );
    for (const { name, cols } of rows) expect(cols, name).toContain('tenant_id');
  });
});

describe('global-table allowlist (ADR-0013 G1 to G3)', () => {
  it('G1: the tables without tenant_id equal the allowlist exactly', async () => {
    expect(await findTenancyProblems(owner)).toEqual([]);
    const { rows } = await owner.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname <> $1
          AND NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
        ORDER BY 1`,
      [TENANT_ROOT_TABLE],
    );
    expect(rows.map((r) => r.relname)).toEqual(Object.keys(GLOBAL_TABLES).sort());
  });

  it('G2: no allowlisted table has a tenant_id column', async () => {
    const { rows } = await owner.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'tenant_id' AND table_name = ANY ($1)`,
      [Object.keys(GLOBAL_TABLES)],
    );
    expect(rows).toEqual([]);
  });

  it('G3: every allowlist entry has a reason', () => {
    expect(Object.keys(GLOBAL_TABLES).length).toBeGreaterThan(0);
    for (const [table, reason] of Object.entries(GLOBAL_TABLES)) expect(reason.trim(), table).not.toBe('');
  });

  it('fails when a global table is created that is not on the allowlist', async () => {
    const problems = await planted('CREATE TABLE public.sneaky (id int)', (c) => findTenancyProblems(c));
    expect(problems).toEqual([{ table: 'sneaky', problem: 'unlisted-global-table' }]);
  });

  it('fails when the allowlist names a table that does not exist', async () => {
    const problems = await findTenancyProblems(owner, { ...GLOBAL_TABLES, ghost: 'A table nobody created.' });
    expect(problems).toEqual([{ table: 'ghost', problem: 'allowlist-entry-without-table' }]);
  });

  it('fails when an allowlisted table carries a tenant_id column', async () => {
    const problems = await planted('CREATE TABLE public.confused (id int, tenant_id uuid)', (c) =>
      findTenancyProblems(c, { ...GLOBAL_TABLES, confused: 'Listed by mistake.' }),
    );
    expect(problems).toEqual([{ table: 'confused', problem: 'allowlisted-table-has-tenant-id' }]);
  });

  it('fails when an allowlist entry has no reason', async () => {
    const problems = await findTenancyProblems(owner, { ...GLOBAL_TABLES, users: '  ' });
    expect(problems).toEqual([{ table: 'users', problem: 'allowlist-entry-without-reason' }]);
  });

  it('a new tenant table without RLS is reported as a gap, not hidden as global', async () => {
    const gaps = await planted('CREATE TABLE public.leaky (id int, tenant_id uuid)', (c) => findRlsGaps(c));
    expect(gaps.map((g) => g.table)).toEqual(['leaky']);
  });
});
