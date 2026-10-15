import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDbOnPool, type Db } from './db.ts';
import { createPool } from './pool.ts';
import { TENANT_TABLES } from './tables.ts';
import { createTestDatabase, type TestDatabase } from './testing/index.ts';
import { provisionTenant, provisionTenantWithId } from './tenancy.ts';

// ADR-0013 tests G4, G5, G6 and G9. (G1 to G3 live in coverage.test.ts. G7, the API-key lookup, ships with
// api_keys in PR 9, and G8, the Valkey key prefix, with the first Valkey key helper in PR 6; both are tracked.)
let testDb: TestDatabase;
let pool: pg.Pool;
let owner: pg.Client;
let db: Db;

async function newUser(label: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>('INSERT INTO users (email) VALUES ($1) RETURNING id', [
    `${label}-${randomUUID()}@example.test`,
  ]);
  return (rows[0] as { id: string }).id;
}

const slug = (label: string): string => `${label}-${randomUUID().slice(0, 8)}`;

beforeAll(async () => {
  testDb = await createTestDatabase({ suite: 'global_tables' });
  pool = createPool({ connectionString: testDb.appUrl, applicationName: 'prysm-global-test', max: 4 });
  db = createDbOnPool(pool);
  owner = new pg.Client({ connectionString: testDb.ownerUrl });
  await owner.connect();
});

afterAll(async () => {
  await owner.end();
  await pool.end();
  await testDb.drop();
});

describe('G4: grants on global tables', () => {
  it('prysm_app has no DELETE on users, and prysm_platform and prysm_gateway_outbox have no privilege on it', async () => {
    const { rows } = await owner.query<Record<string, boolean>>(
      `SELECT has_table_privilege('prysm_app', 'public.users', 'DELETE') AS app_delete,
              has_table_privilege('prysm_app', 'public.users', 'SELECT') AS app_select,
              has_table_privilege('prysm_platform', 'public.users', 'SELECT, INSERT, UPDATE, DELETE') AS platform,
              has_table_privilege('prysm_gateway_outbox', 'public.users', 'SELECT, INSERT, UPDATE, DELETE') AS outbox`,
    );
    expect(rows[0]).toEqual({ app_delete: false, app_select: true, platform: false, outbox: false });
  });
});

describe('G5: tenants is covered by RLS on id', () => {
  it('has RLS enabled and forced and a policy on id, and tenant A sees only its own row', async () => {
    const { rows } = await owner.query<{ rls: boolean; forced: boolean; qual: string }>(
      `SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS forced, pg_get_expr(p.polqual, p.polrelid) AS qual
         FROM pg_class c JOIN pg_policy p ON p.polrelid = c.oid WHERE c.relname = 'tenants'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ rls: true, forced: true });
    expect(rows[0]?.qual).toMatch(/^\(id = /);

    const a = await provisionTenant(db, { slug: slug('g5a'), name: 'A', ownerUserId: await newUser('g5a') });
    const b = await provisionTenant(db, { slug: slug('g5b'), name: 'B', ownerUserId: await newUser('g5b') });
    const seen = await db.withTenant(a.tenantId, (tx) => tx.query<{ id: string }>('SELECT id FROM tenants'));
    expect(seen.rows).toEqual([{ id: a.tenantId }]);
    expect(seen.rows.map((r) => r.id)).not.toContain(b.tenantId);
  });
});

describe('G6: withGlobal reaches the global tables and refuses the tenant ones', () => {
  it('reads and writes users with no tenant set', async () => {
    const email = `g6-${randomUUID()}@example.test`;
    const inserted = await db.withGlobal((tx) =>
      tx.query<{ id: string }>('INSERT INTO users (email) VALUES ($1) RETURNING id', [email]),
    );
    expect(inserted.rows).toHaveLength(1);
    const found = await db.withGlobal((tx) => tx.query('SELECT 1 FROM users WHERE email = $1', [email]));
    expect(found.rows).toHaveLength(1);
    const setting = await db.withGlobal((tx) =>
      tx.query<{ v: string | null }>("SELECT current_setting('app.tenant_id', true) AS v"),
    );
    expect(setting.rows[0]?.v === null || setting.rows[0]?.v === '').toBe(true);
  });

  for (const table of TENANT_TABLES) {
    it(`refuses a statement that names the tenant table ${table}, however it is written`, async () => {
      const statements = [
        `SELECT * FROM ${table}`,
        `select * from "${table}"`,
        `SELECT u.id FROM users u JOIN ${table.toUpperCase()} t ON true`,
        `INSERT INTO ${table} DEFAULT VALUES`,
        `UPDATE public.${table} SET x = 1`,
        `WITH x AS (SELECT 1 FROM ${table}) SELECT 1`,
      ];
      for (const sql of statements)
        await expect(
          db.withGlobal((tx) => tx.query(sql)),
          sql,
        ).rejects.toThrow(/withGlobal cannot touch the tenant table/);
    });
  }

  it('has a tenant-table list in code that equals the catalog (the guard cannot be out of date)', async () => {
    const { rows } = await owner.query<{ relname: string }>(
      `SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p') AND relrowsecurity ORDER BY 1`,
    );
    expect(rows.map((r) => r.relname)).toEqual([...TENANT_TABLES].sort());
  });

  it('even a statement that slips past the guard sees no tenant rows, because no tenant is set', async () => {
    await provisionTenant(db, { slug: slug('g6'), name: 'G6', ownerUserId: await newUser('g6') });
    const { rows } = await pool.query('SELECT * FROM memberships');
    expect(rows).toEqual([]);
  });

  it('the transaction client stops working once withGlobal returns', async () => {
    let leaked: { query: (sql: string) => Promise<unknown> } | undefined;
    await db.withGlobal((tx) => {
      leaked = tx;
      return Promise.resolve();
    });
    await expect(leaked?.query('SELECT 1')).rejects.toThrow(/must not be used after/);
  });
});

describe('G9: signup uses a server-generated tenant id and cannot write into an existing tenant', () => {
  it('creates the tenant, its settings and an Owner membership, under a random v4 UUID', async () => {
    const owner1 = await newUser('g9');
    const { tenantId } = await provisionTenant(db, { slug: slug('g9'), name: 'G9', ownerUserId: owner1 });
    expect(tenantId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const rows = await db.withTenant(tenantId, async (tx) => ({
      tenants: (await tx.query('SELECT 1 FROM tenants')).rows.length,
      settings: (await tx.query('SELECT 1 FROM tenant_settings')).rows.length,
      members: (await tx.query<{ role: string; user_id: string }>('SELECT role, user_id FROM memberships')).rows,
    }));
    expect(rows).toEqual({ tenants: 1, settings: 1, members: [{ role: 'owner', user_id: owner1 }] });
    const other = await provisionTenant(db, { slug: slug('g9b'), name: 'G9b', ownerUserId: await newUser('g9b') });
    expect(other.tenantId).not.toBe(tenantId);
  });

  it('does not let the caller choose the id', async () => {
    const input = { slug: slug('g9c'), name: 'x', ownerUserId: await newUser('g9c'), tenantId: randomUUID() };
    await expect(provisionTenant(db, input)).rejects.toThrow(TypeError);
  });

  it('forcing an existing tenant id aborts at the tenants insert and writes nothing into that tenant', async () => {
    const victimOwner = await newUser('victim');
    const victim = await provisionTenant(db, { slug: slug('victim'), name: 'Victim', ownerUserId: victimOwner });
    const attacker = await newUser('attacker');
    const attempt = provisionTenantWithId(db, victim.tenantId, {
      slug: slug('evil'),
      name: 'Evil',
      ownerUserId: attacker,
    });
    await expect(attempt).rejects.toMatchObject({ code: '23505', constraint: 'tenants_pkey' });
    const after = await db.withTenant(victim.tenantId, async (tx) => ({
      tenants: (await tx.query<{ name: string }>('SELECT name FROM tenants')).rows,
      members: (await tx.query<{ user_id: string }>('SELECT user_id FROM memberships')).rows,
      settings: (await tx.query('SELECT 1 FROM tenant_settings')).rows.length,
    }));
    expect(after.tenants).toEqual([{ name: 'Victim' }]);
    expect(after.members).toEqual([{ user_id: victimOwner }]);
    expect(after.settings).toBe(1);
  });

  it('is atomic: a failing membership insert leaves no tenant or settings row behind', async () => {
    const id = randomUUID();
    await expect(
      provisionTenantWithId(db, id, { slug: slug('atomic'), name: 'Atomic', ownerUserId: randomUUID() }),
    ).rejects.toMatchObject({ code: '23503' });
    // Look inside that tenant's own scope: RLS hides it from every other view, so this is the only honest check.
    const left = await db.withTenant(id, async (tx) => ({
      tenants: (await tx.query('SELECT 1 FROM tenants')).rows.length,
      settings: (await tx.query('SELECT 1 FROM tenant_settings')).rows.length,
    }));
    expect(left).toEqual({ tenants: 0, settings: 0 });
  });
});
