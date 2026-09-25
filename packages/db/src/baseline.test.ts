import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { createPool, findRlsGaps, ping } from './index.ts';
import { requiredUrl } from './test-env.ts';

const owner = createPool({ connectionString: requiredUrl('DATABASE_URL_OWNER'), applicationName: 'prysm-db-test' });
const RUNTIME_ROLES = ['prysm_app', 'prysm_platform', 'prysm_gateway_outbox'];

afterAll(async () => {
  await owner.end();
});

describe('database baseline (ADR-0007)', () => {
  it('has the baseline migration applied', async () => {
    const { rows } = await owner.query<{ n: string }>('SELECT count(*) AS n FROM drizzle.__drizzle_migrations');
    expect(Number(rows[0]?.n)).toBeGreaterThanOrEqual(1);
  });

  it('runtime roles are not superusers, cannot bypass RLS, and cannot create roles or databases', async () => {
    const { rows } = await owner.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean; rolcreatedb: boolean }>(
      'SELECT rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = ANY($1) ORDER BY rolname',
      [RUNTIME_ROLES],
    );
    expect(rows.map((r) => r.rolname)).toEqual([...RUNTIME_ROLES].sort());
    for (const r of rows) expect(r).toMatchObject({ rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false });
  });

  it('owner cannot bypass RLS either, and runtime roles own no objects', async () => {
    const { rows: ownerRow } = await owner.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'prysm_owner'",
    );
    expect(ownerRow[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    const { rows } = await owner.query<{ n: string }>(
      'SELECT count(*) AS n FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE r.rolname = ANY($1)',
      [RUNTIME_ROLES],
    );
    expect(Number(rows[0]?.n)).toBe(0);
  });

  it('only the owner can create objects in public; runtime roles have USAGE', async () => {
    for (const role of RUNTIME_ROLES) {
      const { rows } = await owner.query<{ create: boolean; usage: boolean }>(
        "SELECT has_schema_privilege($1, 'public', 'CREATE') AS create, has_schema_privilege($1, 'public', 'USAGE') AS usage",
        [role],
      );
      expect(rows[0]).toEqual({ create: false, usage: true });
    }
  });

  it('the app role really cannot create a table', async () => {
    const app = new pg.Client({ connectionString: requiredUrl('DATABASE_URL_APP') });
    await app.connect();
    try {
      await expect(app.query('CREATE TABLE public.should_fail (id int)')).rejects.toThrow(/permission denied/);
    } finally {
      await app.end();
    }
  });

  it('has pgvector installed', async () => {
    const { rows } = await owner.query("SELECT extversion FROM pg_extension WHERE extname = 'vector'");
    expect(rows).toHaveLength(1);
  });

  it('ping succeeds', async () => {
    await expect(ping(owner)).resolves.toBeUndefined();
  });
});

describe('findRlsGaps', () => {
  it('reports no gaps on the migrated schema', async () => {
    expect(await findRlsGaps(owner)).toEqual([]);
  });

  it('detects tenant tables missing RLS, FORCE, or a policy (planted gaps, rolled back)', async () => {
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query('CREATE TABLE public.t_no_rls (id int, tenant_id uuid)');
      await client.query('CREATE TABLE public.t_not_forced (id int, tenant_id uuid)');
      await client.query('ALTER TABLE public.t_not_forced ENABLE ROW LEVEL SECURITY');
      await client.query("CREATE POLICY p ON public.t_not_forced USING (tenant_id = current_setting('app.tenant_id', true)::uuid)");
      await client.query('CREATE TABLE public.t_no_policy (id int, tenant_id uuid)');
      await client.query('ALTER TABLE public.t_no_policy ENABLE ROW LEVEL SECURITY');
      await client.query('ALTER TABLE public.t_no_policy FORCE ROW LEVEL SECURITY');
      await client.query('CREATE TABLE public.t_ok (id int, tenant_id uuid)');
      await client.query('ALTER TABLE public.t_ok ENABLE ROW LEVEL SECURITY');
      await client.query('ALTER TABLE public.t_ok FORCE ROW LEVEL SECURITY');
      await client.query("CREATE POLICY p ON public.t_ok USING (tenant_id = current_setting('app.tenant_id', true)::uuid)");
      await client.query('CREATE TABLE public.t_global (id int)');

      const gaps = await findRlsGaps(client);
      expect(gaps).toEqual([
        { table: 't_no_policy', rlsEnabled: true, rlsForced: true, policies: 0 },
        { table: 't_no_rls', rlsEnabled: false, rlsForced: false, policies: 0 },
        { table: 't_not_forced', rlsEnabled: true, rlsForced: false, policies: 1 },
      ]);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
