import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDbOnPool, type Db, type TenantTx } from './db.ts';
import { createPool } from './pool.ts';
import { createTestDatabase, type TestDatabase } from './testing/index.ts';

// A stand-in tenant table with the exact policy shape ADR-0007 prescribes. It lives only in this suite's clone.
let testDb: TestDatabase;
let pool: pg.Pool;
let db: Db;
const tenantA = randomUUID();
const tenantB = randomUUID();

beforeAll(async () => {
  testDb = await createTestDatabase({ suite: 'with_tenant' });
  const owner = new pg.Client({ connectionString: testDb.ownerUrl });
  await owner.connect();
  try {
    await owner.query(`
      CREATE TABLE public.probe (tenant_id uuid NOT NULL, id int NOT NULL, note text, PRIMARY KEY (tenant_id, id));
      ALTER TABLE public.probe ENABLE ROW LEVEL SECURITY;
      ALTER TABLE public.probe FORCE ROW LEVEL SECURITY;
      CREATE POLICY tenant_isolation ON public.probe
        USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
        WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
      GRANT SELECT, INSERT, UPDATE ON public.probe TO prysm_app;`);
  } finally {
    await owner.end();
  }
  pool = createPool({ connectionString: testDb.appUrl, applicationName: 'prysm-db-test', max: 4 });
  db = createDbOnPool(pool);
  await db.withTenant(tenantA, (tx) => tx.query("INSERT INTO probe VALUES ($1, 1, 'a-1'), ($1, 2, 'a-2')", [tenantA]));
  await db.withTenant(tenantB, (tx) => tx.query("INSERT INTO probe VALUES ($1, 1, 'b-1')", [tenantB]));
});

afterAll(async () => {
  await pool.end();
  await testDb.drop();
});

const notes = async (tx: TenantTx): Promise<string[]> =>
  (await tx.query<{ note: string }>('SELECT note FROM probe ORDER BY note')).rows.map((r) => r.note);

describe('withTenant', () => {
  it('shows a tenant only its own rows', async () => {
    expect(await db.withTenant(tenantA, notes)).toEqual(['a-1', 'a-2']);
    expect(await db.withTenant(tenantB, notes)).toEqual(['b-1']);
  });

  it('refuses to write a row for another tenant (WITH CHECK) and leaves nothing behind', async () => {
    await expect(
      db.withTenant(tenantA, (tx) => tx.query("INSERT INTO probe VALUES ($1, 9, 'forged')", [tenantB])),
    ).rejects.toThrow(/row-level security/);
    expect(await db.withTenant(tenantB, notes)).toEqual(['b-1']);
  });

  it("can neither update nor see another tenant's rows", async () => {
    const result = await db.withTenant(tenantA, (tx) => tx.query("UPDATE probe SET note = 'changed' WHERE id = 1"));
    expect(result.rowCount).toBe(1);
    expect(await db.withTenant(tenantB, notes)).toEqual(['b-1']);
    await db.withTenant(tenantA, (tx) => tx.query("UPDATE probe SET note = 'a-1' WHERE id = 1"));
  });

  it('fails closed: with no tenant set, the app role sees nothing', async () => {
    const raw = new pg.Client({ connectionString: testDb.appUrl });
    await raw.connect();
    try {
      const { rows } = await raw.query('SELECT * FROM probe');
      expect(rows).toEqual([]);
    } finally {
      await raw.end();
    }
  });

  it('sets the tenant for the transaction only: nothing is left on the connection afterwards', async () => {
    const one = createPool({ connectionString: testDb.appUrl, applicationName: 'prysm-db-test-one', max: 1 });
    const single = createDbOnPool(one);
    try {
      await single.withTenant(tenantA, notes);
      const { rows } = await one.query<{ v: string | null }>("SELECT current_setting('app.tenant_id', true) AS v");
      expect(rows[0]?.v === null || rows[0]?.v === '').toBe(true);
      // The same single connection serves the next tenant with no residue from the previous one.
      expect(await single.withTenant(tenantB, notes)).toEqual(['b-1']);
    } finally {
      await one.end();
    }
  });

  it('rolls back and rethrows when the callback throws, and the connection stays usable', async () => {
    const one = createPool({ connectionString: testDb.appUrl, applicationName: 'prysm-db-test-one', max: 1 });
    const single = createDbOnPool(one);
    try {
      await expect(
        single.withTenant(tenantA, async (tx) => {
          await tx.query("INSERT INTO probe VALUES ($1, 50, 'doomed')", [tenantA]);
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      expect(await single.withTenant(tenantA, notes)).toEqual(['a-1', 'a-2']);
    } finally {
      await one.end();
    }
  });

  it('commits what the callback wrote', async () => {
    const tenantC = randomUUID();
    await db.withTenant(tenantC, (tx) => tx.query("INSERT INTO probe VALUES ($1, 1, 'c-1')", [tenantC]));
    expect(await db.withTenant(tenantC, notes)).toEqual(['c-1']);
  });

  it('does not leak between tenants under concurrent use of a small pool', async () => {
    const calls = Array.from({ length: 60 }, (_, i) => {
      const tenant = i % 2 === 0 ? tenantA : tenantB;
      return db.withTenant(tenant, async (tx) => {
        await tx.query('SELECT pg_sleep(0.005)');
        const { rows } = await tx.query<{ tenant_id: string }>('SELECT DISTINCT tenant_id FROM probe');
        return { tenant, seen: rows.map((r) => r.tenant_id) };
      });
    });
    for (const { tenant, seen } of await Promise.all(calls)) expect(seen).toEqual([tenant]);
  });

  it('rejects a bad tenant id before taking a connection', async () => {
    for (const bad of ['', 'not-a-uuid', `${tenantA}'; DROP TABLE probe; --`, `${tenantA} `, 42 as unknown as string]) {
      await expect(db.withTenant(bad, notes)).rejects.toThrow(TypeError);
    }
    expect(await db.withTenant(tenantA.toUpperCase(), notes)).toEqual(['a-1', 'a-2']);
  });

  it('makes the transaction client unusable once withTenant has returned', async () => {
    let leaked: TenantTx | undefined;
    await db.withTenant(tenantA, (tx) => {
      leaked = tx;
      return Promise.resolve();
    });
    await expect(leaked?.query('SELECT 1')).rejects.toThrow(/must not be used after/);
  });

  it('ping answers without a tenant', async () => {
    await expect(db.ping()).resolves.toBeUndefined();
  });
});
