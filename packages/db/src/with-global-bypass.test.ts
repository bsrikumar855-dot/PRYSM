import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDbOnPool, type Db } from './db.ts';
import { createPool } from './pool.ts';
import { createTestDatabase, type TestDatabase } from './testing/index.ts';
import { provisionTenant } from './tenancy.ts';

// The withGlobal guard is a text match, so it is defence in depth only. The control is RLS: with no tenant set
// Postgres returns nothing from, and rejects writes to, every tenant table. These tests take the guard away (or
// walk around it) and show RLS alone still holds.
let testDb: TestDatabase;
let pool: pg.Pool;
let db: Db;
let tenantA = '';

/** A transaction with no tenant set: exactly what withGlobal runs, minus the guard. Always rolled back. */
async function withoutGuard<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    return await fn(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

beforeAll(async () => {
  testDb = await createTestDatabase({ suite: 'with_global_bypass' });
  pool = createPool({ connectionString: testDb.appUrl, applicationName: 'prysm-bypass-test', max: 3 });
  db = createDbOnPool(pool);
  const { rows } = await pool.query<{ id: string }>('INSERT INTO users (email) VALUES ($1) RETURNING id', [
    `bypass-${randomUUID()}@example.test`,
  ]);
  tenantA = (
    await provisionTenant(db, {
      slug: `bp-${randomUUID().slice(0, 8)}`,
      name: 'A',
      ownerUserId: (rows[0] as { id: string }).id,
    })
  ).tenantId;
});

afterAll(async () => {
  await pool.end();
  await testDb.drop();
});

/** Spellings the guard DOES catch. With the guard removed they must still read zero rows. */
const NAMED = [
  'SELECT * FROM tenants',
  'SELECT * FROM "tenants"',
  'SELECT * FROM public.tenants',
  'SELECT * FROM public."tenants"',
  'WITH x AS (SELECT * FROM tenants) SELECT * FROM x',
  'SELECT * FROM memberships',
  'SELECT * FROM tenant_settings',
  'SELECT t.* FROM tenants t JOIN memberships m ON m.tenant_id = t.id',
];

/** Statements that name no tenant table in plain text, so the guard lets them through. */
const EVASIVE = [
  'SELECT * FROM U&"ten\\0061nts"',
  'SELECT * FROM U&"memb\\0065rships"',
  'SELECT * FROM U&"tenant\\005fsettings"',
  'SELECT * FROM public.U&"ten\\0061nts"',
  "SELECT count(*) AS n FROM xmltable('/table/row' PASSING query_to_xml('SELECT * FROM ten' || 'ants', true, false, '') COLUMNS id text PATH 'id')",
];

describe('withGlobal guard is defence in depth: RLS still returns nothing with the guard removed', () => {
  for (const sql of NAMED) {
    it(`no tenant set, no guard: ${sql}`, async () => {
      const { rows } = await withoutGuard((c) => c.query(sql));
      if (sql.includes('count(*)')) expect(rows[0]).toMatchObject({ n: '0' });
      else expect(rows).toEqual([]);
    });
  }

  it('the guard does catch every one of those spellings (so it is a real layer, just not the only one)', async () => {
    for (const sql of NAMED)
      await expect(
        db.withGlobal((tx) => tx.query(sql)),
        sql,
      ).rejects.toThrow(/withGlobal cannot touch the tenant table/);
  });
});

describe('statements that walk around the guard still see no tenant rows', () => {
  for (const sql of EVASIVE) {
    it(`passes the guard but returns zero rows: ${sql}`, async () => {
      const result = await db.withGlobal((tx) => tx.query<Record<string, string>>(sql));
      const rows = result.rows;
      if (sql.includes('count(*)')) expect(rows[0]).toMatchObject({ n: '0' });
      else expect(rows).toEqual([]);
    });

    it(`is a real tenant-table read (control): the same statement inside withTenant finds the tenant's row: ${sql}`, async () => {
      const result = await db.withTenant(tenantA, (tx) => tx.query<Record<string, string>>(sql));
      if (sql.includes('count(*)')) expect(Number(result.rows[0]?.['n'])).toBeGreaterThanOrEqual(1);
      else expect(result.rows.length).toBeGreaterThanOrEqual(1);
    });
  }

  it('query_to_xml of a tenant table through withGlobal contains no row', async () => {
    const { rows } = await db.withGlobal((tx) =>
      tx.query<{ x: string }>("SELECT query_to_xml('SELECT * FROM ten' || 'ants', true, false, '')::text AS x"),
    );
    expect(rows[0]?.x).not.toContain('<row');
  });

  it('writes that walk around the guard are rejected by RLS or the grants', async () => {
    await expect(
      db.withGlobal((tx) =>
        tx.query('INSERT INTO U&"ten\\0061nts" (id, slug, name) VALUES ($1, $2, $3)', [
          randomUUID(),
          `evil-${randomUUID().slice(0, 8)}`,
          'x',
        ]),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      db.withGlobal((tx) =>
        tx.query('INSERT INTO U&"memb\\0065rships" (tenant_id, user_id, role) VALUES ($1, $1, \'owner\')', [tenantA]),
      ),
    ).rejects.toThrow(/row-level security/);
    const update = await db.withGlobal((tx) => tx.query('UPDATE U&"ten\\0061nts" SET name = \'pwned\''));
    expect(update.rowCount).toBe(0);
    await expect(db.withGlobal((tx) => tx.query('DELETE FROM U&"ten\\0061nts"'))).rejects.toThrow(/permission denied/);
    const still = await db.withTenant(tenantA, (tx) => tx.query<{ name: string }>('SELECT name FROM tenants'));
    expect(still.rows).toEqual([{ name: 'A' }]);
  });
});
