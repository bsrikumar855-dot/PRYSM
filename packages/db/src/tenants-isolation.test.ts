import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDbOnPool, type Db } from './db.ts';
import { createPool } from './pool.ts';
import { createTestDatabase, type TestDatabase } from './testing/index.ts';
import { provisionTenant } from './tenancy.ts';

// A direct isolation test for the tenants table, written so that dropping or loosening its policy fails a NAMED
// test, not just a beforeAll. Nothing is seeded in beforeAll: each test creates the tenants it needs, so with the
// policy gone the failure shows up in the test that depends on it (the generic suite in isolation.test.ts seeds
// once, and without a policy it can only report that seeding failed).
let testDb: TestDatabase;
let pool: pg.Pool;
let identityPool: pg.Pool;
let owner: pg.Client;
let db: Db;

async function newTenant(label: string): Promise<string> {
  const { rows } = await identityPool.query<{ id: string }>('INSERT INTO users (email) VALUES ($1) RETURNING id', [
    `${label}-${randomUUID()}@example.test`,
  ]);
  const ownerUserId = (rows[0] as { id: string }).id;
  return (await provisionTenant(db, { slug: `${label}-${randomUUID().slice(0, 8)}`, name: label, ownerUserId }))
    .tenantId;
}

beforeAll(async () => {
  testDb = await createTestDatabase({ suite: 'tenants_isolation' });
  pool = createPool({ connectionString: testDb.appUrl, applicationName: 'prysm-tenants-test', max: 3 });
  identityPool = createPool({
    connectionString: testDb.identityUrl,
    applicationName: 'prysm-tenants-identity',
    max: 2,
  });
  db = createDbOnPool(pool, identityPool);
  owner = new pg.Client({ connectionString: testDb.ownerUrl });
  await owner.connect();
});

afterAll(async () => {
  await owner.end();
  await pool.end();
  await identityPool.end();
  await testDb.drop();
});

describe('tenants isolation (direct, self-seeding)', () => {
  it('tenants has a FOR ALL policy on id with both USING and WITH CHECK, and RLS enabled and forced', async () => {
    const { rows } = await owner.query<{
      rls: boolean;
      forced: boolean;
      cmd: string;
      using: string | null;
      check: string | null;
    }>(
      `SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS forced, p.polcmd AS cmd,
              pg_get_expr(p.polqual, p.polrelid) AS using, pg_get_expr(p.polwithcheck, p.polrelid) AS check
         FROM pg_class c LEFT JOIN pg_policy p ON p.polrelid = c.oid WHERE c.oid = 'public.tenants'::regclass`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ rls: true, forced: true, cmd: '*' });
    expect(rows[0]?.using).toMatch(/^\(id = /);
    expect(rows[0]?.check).toMatch(/^\(id = /);
  });

  it('a new tenant can be created, and sees exactly its own row', async () => {
    const a = await newTenant('own');
    const seen = await db.withTenant(a, (tx) => tx.query<{ id: string }>('SELECT id FROM tenants'));
    expect(seen.rows).toEqual([{ id: a }]);
  });

  it("tenant A cannot see tenant B's row, by listing or by asking for it", async () => {
    const a = await newTenant('seea');
    const b = await newTenant('seeb');
    const listed = await db.withTenant(a, (tx) => tx.query<{ id: string }>('SELECT id FROM tenants'));
    expect(listed.rows.map((r) => r.id)).toEqual([a]);
    const asked = await db.withTenant(a, (tx) => tx.query('SELECT 1 FROM tenants WHERE id = $1', [b]));
    expect(asked.rows).toEqual([]);
  });

  it('with no tenant, an empty setting or a malformed one, tenants reads as empty even though rows exist', async () => {
    await newTenant('none');
    for (const setting of [undefined, '', 'not-a-uuid']) {
      const c = await pool.connect();
      try {
        if (setting !== undefined) await c.query("SELECT set_config('app.tenant_id', $1, false)", [setting]);
        const { rows } = await c.query('SELECT * FROM tenants');
        expect(rows, JSON.stringify(setting)).toEqual([]);
      } finally {
        c.release(true); // session-level setting: do not return this connection to the pool
      }
    }
  });

  it("tenant A cannot rename, move or delete tenant B's row, and cannot create a tenant row with B's id", async () => {
    const a = await newTenant('moda');
    const b = await newTenant('modb');
    const renamed = await db.withTenant(a, (tx) => tx.query("UPDATE tenants SET name = 'pwned' WHERE id = $1", [b]));
    expect(renamed.rowCount).toBe(0);
    await expect(
      db.withTenant(a, (tx) => tx.query('UPDATE tenants SET id = $1 WHERE id = $2', [b, a])),
    ).rejects.toThrow(/permission denied/);
    await expect(
      db.withTenant(a, (tx) =>
        tx.query("INSERT INTO tenants (id, slug, name) VALUES ($1, $2, 'x')", [b, `dup-${randomUUID().slice(0, 8)}`]),
      ),
    ).rejects.toThrow(/row-level security/);
    const intact = await db.withTenant(b, (tx) => tx.query<{ name: string }>('SELECT name FROM tenants'));
    expect(intact.rows.map((r) => r.name)).toEqual(['modb']);
  });
});
