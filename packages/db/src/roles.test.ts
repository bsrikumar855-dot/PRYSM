import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './testing/index.ts';

// Hard requirement 2: the table owner is not the app role, the app role cannot bypass or change RLS, holds
// least-privilege grants only, and no role anywhere has BYPASSRLS.
const OWNER = 'prysm_owner';
const APP = 'prysm_app';
const OTHER_RUNTIME_ROLES = ['prysm_platform', 'prysm_gateway_outbox'];

/** What prysm_app may do, exactly. A new table fails this test until its grants are reviewed and added. */
const EXPECTED_APP_GRANTS: Record<string, { table: string[]; updateColumns: string[] }> = {
  tenants: { table: ['INSERT', 'SELECT'], updateColumns: ['name', 'status'] },
  tenant_settings: {
    table: ['INSERT', 'SELECT'],
    updateColumns: ['retention_days', 'retention_mode', 'sso_config_enc', 'updated_at'],
  },
  memberships: { table: ['INSERT', 'SELECT'], updateColumns: ['role', 'status'] },
  // F-49: prysm_app holds no table-level privilege on users and no UPDATE column; its four SELECT columns are checked below.
  users: { table: [], updateColumns: [] },
};

let db: TestDatabase;
let owner: pg.Client;
let app: pg.Client;

beforeAll(async () => {
  db = await createTestDatabase({ suite: 'roles' });
  owner = new pg.Client({ connectionString: db.ownerUrl });
  app = new pg.Client({ connectionString: db.appUrl });
  await Promise.all([owner.connect(), app.connect()]);
});

afterAll(async () => {
  await Promise.all([owner.end(), app.end()]);
  await db.drop();
});

describe('roles and ownership', () => {
  it('the app role is NOSUPERUSER NOBYPASSRLS and cannot create roles or databases', async () => {
    const { rows } = await owner.query(
      'SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication FROM pg_roles WHERE rolname = $1',
      [APP],
    );
    expect(rows).toEqual([
      { rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false },
    ]);
  });

  it('no role other than a superuser has BYPASSRLS anywhere in the cluster', async () => {
    const { rows } = await owner.query('SELECT rolname FROM pg_roles WHERE rolbypassrls AND NOT rolsuper');
    expect(rows).toEqual([]);
  });

  it('every public table and function (extensions aside), including the helper, is owned by prysm_owner and never by the app role', async () => {
    const { rows } = await owner.query<{ name: string; owner: string }>(
      `SELECT c.relname AS name, pg_get_userbyid(c.relowner) AS owner FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'S')
       UNION ALL
       SELECT p.proname, pg_get_userbyid(p.proowner) FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
          AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.owner, row.name).toBe(OWNER);
  });

  it('the owner is subject to RLS too: with no tenant it can neither read nor write a tenant table', async () => {
    await expect(
      owner.query("INSERT INTO tenant_settings (tenant_id) VALUES ('00000000-0000-4000-8000-000000000001')"),
    ).rejects.toThrow(/row-level security|foreign key/);
    const { rows } = await owner.query('SELECT * FROM memberships');
    expect(rows).toEqual([]);
  });

  it('no SECURITY DEFINER function exists in public (no RLS bypass path)', async () => {
    const { rows } = await owner.query(
      `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.prosecdef`,
    );
    expect(rows).toEqual([]);
  });
});

describe('least-privilege grants', () => {
  it('prysm_app holds exactly the reviewed table and column privileges, and nothing on any other table', async () => {
    const { rows: tables } = await owner.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY 1`,
    );
    expect(tables.map((t) => t.relname)).toEqual(Object.keys(EXPECTED_APP_GRANTS).sort());

    for (const { relname } of tables) {
      const { rows: tableLevel } = await owner.query<{ p: string }>(
        `SELECT DISTINCT a.privilege_type AS p
           FROM pg_class c, aclexplode(c.relacl) a
          WHERE c.relname = $1 AND c.relnamespace = 'public'::regnamespace AND a.grantee = $2::regrole ORDER BY 1`,
        [relname, APP],
      );
      const { rows: updateCols } = await owner.query<{ c: string }>(
        `SELECT att.attname AS c FROM pg_attribute att, aclexplode(att.attacl) a
          WHERE att.attrelid = $1::regclass AND a.grantee = $2::regrole AND a.privilege_type = 'UPDATE' ORDER BY 1`,
        [`public.${relname}`, APP],
      );
      expect(
        tableLevel.map((r) => r.p),
        `${relname} table privileges`,
      ).toEqual(EXPECTED_APP_GRANTS[relname]?.table);
      expect(
        updateCols.map((r) => r.c),
        `${relname} UPDATE columns`,
      ).toEqual(EXPECTED_APP_GRANTS[relname]?.updateColumns);
    }
  });

  it('prysm_app can never DELETE, TRUNCATE, REFERENCE or TRIGGER on any table, and cannot UPDATE a key or tenant_id column', async () => {
    const { rows } = await owner.query<{ relname: string; priv: string; ok: boolean }>(
      `SELECT c.relname, p.priv, has_table_privilege($1, c.oid, p.priv) AS ok
         FROM pg_class c, unnest(ARRAY['DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS p(priv)
        WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')`,
      [APP],
    );
    expect(rows.filter((r) => r.ok)).toEqual([]);
    const { rows: keys } = await owner.query<{ ok: boolean }>(
      `SELECT has_column_privilege($1, 'memberships', 'tenant_id', 'UPDATE') AS ok
       UNION ALL SELECT has_column_privilege($1, 'tenants', 'id', 'UPDATE')
       UNION ALL SELECT has_column_privilege($1, 'tenant_settings', 'tenant_id', 'UPDATE')`,
      [APP],
    );
    expect(keys.map((k) => k.ok)).toEqual([false, false, false]);
  });

  it('PUBLIC, prysm_platform and prysm_gateway_outbox hold no privilege on any table or on the helper function', async () => {
    const { rows } = await owner.query<{ who: string; what: string }>(
      `SELECT r.who, c.relname AS what
         FROM pg_class c, unnest($1::text[]) AS r(who)
        WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
          AND (has_table_privilege(r.who, c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
               OR EXISTS (SELECT 1 FROM pg_attribute att WHERE att.attrelid = c.oid AND att.attnum > 0
                          AND has_column_privilege(r.who, c.oid, att.attnum, 'SELECT, INSERT, UPDATE, REFERENCES')))`,
      [OTHER_RUNTIME_ROLES],
    );
    expect(rows).toEqual([]);
    const { rows: acl } = await owner.query<{ n: string }>(
      `SELECT count(*) AS n FROM pg_class c, aclexplode(c.relacl) a
        WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND a.grantee = 0`,
    );
    expect(Number(acl[0]?.n)).toBe(0);
    const { rows: fn } = await owner.query<{ platform: boolean; app: boolean }>(
      `SELECT has_function_privilege('prysm_platform', 'public.app_tenant_id()', 'EXECUTE') AS platform,
              has_function_privilege($1, 'public.app_tenant_id()', 'EXECUTE') AS app`,
      [APP],
    );
    expect(fn[0]).toEqual({ platform: false, app: true });
  });
});

describe('the app role cannot weaken RLS or change the schema', () => {
  const attempts: [string, string][] = [
    ['disable RLS', 'ALTER TABLE public.memberships DISABLE ROW LEVEL SECURITY'],
    ['stop forcing RLS', 'ALTER TABLE public.memberships NO FORCE ROW LEVEL SECURITY'],
    ['drop a policy', 'DROP POLICY tenant_isolation ON public.memberships'],
    ['add a permissive policy', 'CREATE POLICY open_door ON public.memberships USING (true)'],
    ['alter a policy', 'ALTER POLICY tenant_isolation ON public.memberships USING (true)'],
    ['take ownership of a table', 'ALTER TABLE public.memberships OWNER TO prysm_app'],
    ['create a table', 'CREATE TABLE public.should_fail (id int)'],
    ['drop a table', 'DROP TABLE public.tenant_settings'],
    ['truncate a table', 'TRUNCATE public.memberships'],
    ['add a column', 'ALTER TABLE public.memberships ADD COLUMN evil int'],
    [
      'replace the tenant helper',
      'CREATE OR REPLACE FUNCTION public.app_tenant_id() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$',
    ],
    ['drop the tenant helper', 'DROP FUNCTION public.app_tenant_id()'],
    ['create a schema', 'CREATE SCHEMA sneaky'],
    ['become the owner role', 'SET ROLE prysm_owner'],
  ];
  for (const [what, sql] of attempts) {
    it(`cannot ${what}`, async () => {
      await expect(app.query(sql)).rejects.toThrow(/permission denied|must be owner|must be member|permission/i);
    });
  }

  it('cannot grant itself more: GRANT is a no-op without grant option and DELETE stays denied', async () => {
    await app.query('GRANT DELETE ON public.memberships TO prysm_app');
    const { rows } = await owner.query<{ ok: boolean }>(
      "SELECT has_table_privilege($1, 'public.memberships', 'DELETE') AS ok",
      [APP],
    );
    expect(rows).toEqual([{ ok: false }]);
  });

  it('turning row_security off does not expose rows: the query errors instead', async () => {
    await app.query('BEGIN');
    try {
      await app.query("SELECT set_config('app.tenant_id', '00000000-0000-4000-8000-0000000000aa', true)");
      await app.query('SET LOCAL row_security = off');
      await expect(app.query('SELECT * FROM memberships')).rejects.toThrow(/row-level security/);
    } finally {
      await app.query('ROLLBACK');
    }
  });
});
