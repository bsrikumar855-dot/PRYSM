import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDbOnPool, type Db } from './db.ts';
import { createPool } from './pool.ts';
import { TENANT_ROOT_TABLE, TENANT_TABLES } from './tables.ts';
import { createTestDatabase, type TestDatabase } from './testing/index.ts';

// ADR-0007 test 2, generated: for EVERY tenant table, tenant A can neither see nor change tenant B's rows,
// as the real app role and also as the table owner (FORCE ROW LEVEL SECURITY binds the owner too), so the
// policy is proved independently of the grants. A table with no fixture fails the canary below, so a new
// tenant table cannot be silently skipped.

type Role = 'app' | 'owner';
const ROLES: Role[] = ['app', 'owner'];
const RLS_ERROR = /row-level security/;

interface Fixture {
  /** Column that holds the tenant: `tenant_id`, or `id` for the tenants table itself. */
  tenantColumn: 'tenant_id' | 'id';
  /** SQL + values that insert one row for `tenantId`. `tag` keeps unique columns distinct. */
  insert(tenantId: string, tag: string): { text: string; values: unknown[] };
  /** A harmless UPDATE ... SET clause on a column prysm_app may update. */
  update: string;
}

let userIdByTenant = new Map<string, string>();

const FIXTURES: Record<string, Fixture> = {
  tenants: {
    tenantColumn: 'id',
    insert: (tenantId, tag) => ({
      text: 'INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $3)',
      values: [tenantId, `iso-${tenantId.slice(0, 8)}-${tag}`, `Tenant ${tag}`],
    }),
    update: "name = 'renamed'",
  },
  tenant_settings: {
    tenantColumn: 'tenant_id',
    insert: (tenantId) => ({ text: 'INSERT INTO tenant_settings (tenant_id) VALUES ($1)', values: [tenantId] }),
    update: 'retention_days = 400',
  },
  memberships: {
    tenantColumn: 'tenant_id',
    insert: (tenantId) => ({
      text: "INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'engineer')",
      values: [tenantId, userIdByTenant.get(tenantId) ?? randomUUID()],
    }),
    update: "role = 'reviewer'",
  },
};
/** Seeding order: parents first. */
const SEED_ORDER = ['tenants', 'tenant_settings', 'memberships'];

const tenantA = randomUUID();
const tenantB = randomUUID();
let testDb: TestDatabase;
let appPool: pg.Pool;
let identityPool: pg.Pool;
let appDb: Db;
let ownerPool: pg.Pool;

/** Runs `fn` on a fresh connection for `role`, optionally with a session-level tenant setting. */
async function onConnection<T>(role: Role, setting: string | undefined, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: role === 'app' ? testDb.appUrl : testDb.ownerUrl });
  await client.connect();
  try {
    if (setting !== undefined) await client.query("SELECT set_config('app.tenant_id', $1, false)", [setting]);
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Runs `fn` in a transaction scoped to `tenant` as `role`, and always rolls back, so attempts leave no trace. */
async function scoped<T>(role: Role, tenant: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  return onConnection(role, undefined, async (c) => {
    await c.query('BEGIN');
    try {
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
      return await fn(c);
    } finally {
      await c.query('ROLLBACK');
    }
  });
}

/** Every row of `table` belonging to `tenant`, read as the owner under that tenant, as comparable JSON. */
async function rowsOf(table: string, tenant: string): Promise<string[]> {
  const f = FIXTURES[table] as Fixture;
  const { rows } = await scoped('owner', tenant, (c) =>
    c.query<{ j: string }>(`SELECT to_jsonb(t)::text AS j FROM ${table} t WHERE ${f.tenantColumn} = $1 ORDER BY 1`, [
      tenant,
    ]),
  );
  return rows.map((r) => r.j);
}

beforeAll(async () => {
  testDb = await createTestDatabase({ suite: 'isolation' });
  appPool = createPool({ connectionString: testDb.appUrl, applicationName: 'prysm-isolation-app', max: 4 });
  ownerPool = createPool({ connectionString: testDb.ownerUrl, applicationName: 'prysm-isolation-owner', max: 2 });
  identityPool = createPool({
    connectionString: testDb.identityUrl,
    applicationName: 'prysm-isolation-identity',
    max: 2,
  });
  appDb = createDbOnPool(appPool, identityPool);
  // Global users first (one per tenant), then each tenant's rows through the real withTenant path.
  userIdByTenant = new Map();
  for (const tenant of [tenantA, tenantB]) {
    const { rows } = await identityPool.query<{ id: string }>('INSERT INTO users (email) VALUES ($1) RETURNING id', [
      `user-${tenant}@example.test`,
    ]);
    userIdByTenant.set(tenant, (rows[0] as { id: string }).id);
  }
  for (const tenant of [tenantA, tenantB]) {
    await appDb.withTenant(tenant, async (tx) => {
      for (const table of SEED_ORDER) {
        const { text, values } = (FIXTURES[table] as Fixture).insert(tenant, 'seed');
        await tx.query(text, values);
      }
    });
  }
});

afterAll(async () => {
  await Promise.all([appPool.end(), ownerPool.end(), identityPool.end()]);
  await testDb.drop();
});

describe('isolation suite canary', () => {
  it('has a fixture for every tenant table, so none can be skipped silently', () => {
    expect(Object.keys(FIXTURES).sort()).toEqual([...TENANT_TABLES].sort());
    expect([...SEED_ORDER].sort()).toEqual([...TENANT_TABLES].sort());
  });

  it('seeded one row per tenant in every table, and the two tenants differ', async () => {
    expect(tenantA).not.toBe(tenantB);
    for (const table of TENANT_TABLES) {
      expect((await rowsOf(table, tenantA)).length, `${table} A`).toBe(1);
      expect((await rowsOf(table, tenantB)).length, `${table} B`).toBe(1);
    }
  });
});

const noTenantVariants: [string, string | undefined][] = [
  ['no setting at all', undefined],
  ['an empty-string setting', ''],
  ['a malformed (non-UUID) setting', 'not-a-uuid'],
  ['a malformed setting that looks like a UUID', 'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz'],
  ['the UUID of a tenant that does not exist', randomUUID()],
];

describe.each(TENANT_TABLES)('isolation › %s', (table) => {
  const f = FIXTURES[table] as Fixture;

  for (const role of ROLES) {
    it(`SELECT as ${role}: tenant A sees only its own rows, never B's`, async () => {
      const { rows } = await scoped(role, tenantA, (c) =>
        c.query<{ t: string }>(`SELECT DISTINCT ${f.tenantColumn}::text AS t FROM ${table}`),
      );
      expect(rows.map((r) => r.t)).toEqual([tenantA]);
      const { rows: peek } = await scoped(role, tenantA, (c) =>
        c.query(`SELECT 1 FROM ${table} WHERE ${f.tenantColumn} = $1`, [tenantB]),
      );
      expect(peek).toEqual([]);
    });

    for (const [label, setting] of noTenantVariants) {
      it(`SELECT as ${role} with ${label}: zero rows, no error`, async () => {
        const { rows } = await onConnection(role, setting, (c) => c.query(`SELECT * FROM ${table}`));
        expect(rows).toEqual([]);
      });

      it(`INSERT as ${role} with ${label}: rejected by RLS, not by a cast error`, async () => {
        const { text, values } = f.insert(tenantA, `nt-${Math.random().toString(36).slice(2, 8)}`);
        await expect(onConnection(role, setting, (c) => c.query(text, values))).rejects.toThrow(RLS_ERROR);
      });
    }

    it(`INSERT as ${role}: cannot create a row for another tenant`, async () => {
      const { text, values } = f.insert(tenantB, 'forged');
      await expect(scoped(role, tenantA, (c) => c.query(text, values))).rejects.toThrow(RLS_ERROR);
      expect((await rowsOf(table, tenantB)).length).toBe(1);
    });

    it(`UPDATE as ${role}: cannot change another tenant's rows (0 rows, B unchanged)`, async () => {
      const before = await rowsOf(table, tenantB);
      const result = await scoped(role, tenantA, (c) =>
        c.query(`UPDATE ${table} SET ${f.update} WHERE ${f.tenantColumn} = $1`, [tenantB]),
      );
      expect(result.rowCount).toBe(0);
      expect(await rowsOf(table, tenantB)).toEqual(before);
    });

    it(`UPDATE as ${role}: can change its own rows (so the test above is not vacuous)`, async () => {
      const result = await scoped(role, tenantA, (c) =>
        c.query(`UPDATE ${table} SET ${f.update} WHERE ${f.tenantColumn} = $1`, [tenantA]),
      );
      expect(result.rowCount).toBe(1);
    });

    it(`UPDATE ${f.tenantColumn} as ${role}: cannot move a row to another tenant`, async () => {
      const before = await rowsOf(table, tenantA);
      const attempt = scoped(role, tenantA, (c) =>
        c.query(`UPDATE ${table} SET ${f.tenantColumn} = $1 WHERE ${f.tenantColumn} = $2`, [tenantB, tenantA]),
      );
      // The owner gets as far as the policy (WITH CHECK); the app role has no UPDATE on the column at all.
      await expect(attempt).rejects.toThrow(role === 'owner' ? RLS_ERROR : /permission denied/);
      expect(await rowsOf(table, tenantA)).toEqual(before);
      expect((await rowsOf(table, tenantB)).length).toBe(1);
    });

    it(`DELETE as ${role}: cannot delete another tenant's rows`, async () => {
      const before = await rowsOf(table, tenantB);
      const attempt = scoped(role, tenantA, (c) =>
        c.query(`DELETE FROM ${table} WHERE ${f.tenantColumn} = $1`, [tenantB]),
      );
      if (role === 'owner') expect((await attempt).rowCount).toBe(0);
      else await expect(attempt).rejects.toThrow(/permission denied/);
      expect(await rowsOf(table, tenantB)).toEqual(before);
    });
  }

  it('DELETE control: the owner is allowed to delete its own tenant row (or stopped only by a foreign key)', async () => {
    const outcome = await scoped('owner', tenantA, async (c) => {
      await c.query('SAVEPOINT s');
      try {
        return (await c.query(`DELETE FROM ${table} WHERE ${f.tenantColumn} = $1`, [tenantA])).rowCount;
      } catch (error) {
        await c.query('ROLLBACK TO SAVEPOINT s');
        return (error as { code?: string }).code;
      }
    });
    expect(outcome === 1 || outcome === '23503').toBe(true);
  });

  it('the app role has no DELETE or TRUNCATE on it at all', async () => {
    await expect(
      scoped('app', tenantA, (c) => c.query(`DELETE FROM ${table} WHERE ${f.tenantColumn} = $1`, [tenantA])),
    ).rejects.toThrow(/permission denied/);
    await expect(scoped('app', tenantA, (c) => c.query(`TRUNCATE ${table}`))).rejects.toThrow(/permission denied/);
  });
});

describe('isolation › the tenant setting is transaction-local (no leakage across pooled connections)', () => {
  it('tenant A, then tenant B, then no tenant on the SAME connection: each sees only its own rows, then nothing', async () => {
    const one = createPool({ connectionString: testDb.appUrl, applicationName: 'prysm-isolation-one', max: 1 });
    const single = createDbOnPool(one);
    try {
      const pid = async (): Promise<number> => {
        const { rows } = await one.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        return (rows[0] as { pid: number }).pid;
      };
      const countsInTenant = (tenant: string): Promise<Record<string, number>> =>
        single.withTenant(tenant, async (tx) => {
          const out: Record<string, number> = {};
          for (const table of TENANT_TABLES) {
            const f = FIXTURES[table] as Fixture;
            const { rows } = await tx.query<{ n: string; others: string }>(
              `SELECT count(*) AS n, count(*) FILTER (WHERE ${f.tenantColumn} <> $1) AS others FROM ${table}`,
              [tenant],
            );
            expect(Number(rows[0]?.others), `${table} rows of another tenant`).toBe(0);
            out[table] = Number(rows[0]?.n);
          }
          return out;
        });

      const pidBefore = await pid();
      const a = await countsInTenant(tenantA);
      const b = await countsInTenant(tenantB);
      const pidAfter = await pid();
      expect(pidAfter).toBe(pidBefore); // proves one physical connection served A, B and the checks
      for (const table of TENANT_TABLES) {
        expect(a[table], `${table} A`).toBe(1);
        expect(b[table], `${table} B`).toBe(1);
      }

      // Now the same connection with no tenant at all: the setting must be empty and every table must read as empty.
      const { rows: setting } = await one.query<{ v: string | null }>(
        "SELECT current_setting('app.tenant_id', true) AS v",
      );
      expect(setting[0]?.v === null || setting[0]?.v === '').toBe(true);
      for (const table of TENANT_TABLES) {
        const { rows } = await one.query(`SELECT 1 FROM ${table}`);
        expect(rows, `${table} with no tenant`).toEqual([]);
      }
      expect(await pid()).toBe(pidBefore);
    } finally {
      await one.end();
    }
  });

  it('a failed (rolled back) tenant transaction leaves nothing behind either', async () => {
    const one = createPool({ connectionString: testDb.appUrl, applicationName: 'prysm-isolation-one', max: 1 });
    const single = createDbOnPool(one);
    try {
      await expect(
        single.withTenant(tenantA, async (tx) => {
          await tx.query('SELECT 1');
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      const { rows } = await one.query('SELECT 1 FROM memberships');
      expect(rows).toEqual([]);
    } finally {
      await one.end();
    }
  });
});

describe('isolation › foreign keys cannot cross tenants', () => {
  it('a row for tenant A cannot reference tenant B through the tenant_id foreign key (forging it is an RLS failure)', async () => {
    for (const table of TENANT_TABLES.filter((t) => t !== TENANT_ROOT_TABLE)) {
      const f = FIXTURES[table] as Fixture;
      const { text, values } = f.insert(tenantB, 'fk-forge');
      await expect(
        scoped('app', tenantA, (c) => c.query(text, values)),
        table,
      ).rejects.toThrow(RLS_ERROR);
    }
  });

  it('the composite (tenant_id, id) foreign key pattern refuses a cross-tenant reference that a single-column key allows', async () => {
    // A throwaway parent/child pair in this suite's clone, with the policy shape every tenant table uses.
    const owner = await ownerPool.connect();
    const parentB = randomUUID();
    try {
      await owner.query(`
        CREATE TABLE public.fk_parent (tenant_id uuid NOT NULL, id uuid NOT NULL, PRIMARY KEY (tenant_id, id));
        CREATE TABLE public.fk_child_composite (
          tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), parent_id uuid NOT NULL,
          PRIMARY KEY (tenant_id, id),
          FOREIGN KEY (tenant_id, parent_id) REFERENCES public.fk_parent (tenant_id, id));
        CREATE TABLE public.fk_parent_plain (id uuid PRIMARY KEY, tenant_id uuid NOT NULL);
        CREATE TABLE public.fk_child_single (
          tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(),
          parent_id uuid NOT NULL REFERENCES public.fk_parent_plain (id), PRIMARY KEY (tenant_id, id));`);
      for (const t of ['fk_parent', 'fk_child_composite', 'fk_parent_plain', 'fk_child_single']) {
        await owner.query(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY; ALTER TABLE public.${t} FORCE ROW LEVEL SECURITY;
          CREATE POLICY tenant_isolation ON public.${t} USING (tenant_id = (SELECT public.app_tenant_id()))
            WITH CHECK (tenant_id = (SELECT public.app_tenant_id()));
          GRANT SELECT, INSERT ON public.${t} TO prysm_app;`);
      }
      await appDb.withTenant(tenantB, async (tx) => {
        await tx.query('INSERT INTO fk_parent VALUES ($1, $2)', [tenantB, parentB]);
        await tx.query('INSERT INTO fk_parent_plain VALUES ($1, $2)', [parentB, tenantB]);
      });
      // Composite key: tenant A pointing at B's parent id finds no (A, parentB) pair.
      await expect(
        appDb.withTenant(tenantA, (tx) =>
          tx.query('INSERT INTO fk_child_composite (tenant_id, parent_id) VALUES ($1, $2)', [tenantA, parentB]),
        ),
      ).rejects.toThrow(/foreign key/);
      // Negative control: a single-column key accepts the same cross-tenant reference (RI checks bypass RLS).
      await expect(
        appDb.withTenant(tenantA, (tx) =>
          tx.query('INSERT INTO fk_child_single (tenant_id, parent_id) VALUES ($1, $2)', [tenantA, parentB]),
        ),
      ).resolves.toBeDefined();
    } finally {
      owner.release();
    }
  });
});
