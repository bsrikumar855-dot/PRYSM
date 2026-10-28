import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GLOBAL_TABLES, TENANT_TABLES } from './tables.ts';
import { createTestDatabase, type TestDatabase } from './testing/index.ts';

// The shape of the tenant-id helper and of every policy (ADR-0007 as amended by the 0002 policy form).
let testDb: TestDatabase;
let owner: pg.Client;

beforeAll(async () => {
  testDb = await createTestDatabase({ suite: 'policy_form' });
  owner = new pg.Client({ connectionString: testDb.ownerUrl });
  await owner.connect();
});

afterAll(async () => {
  await owner.end();
  await testDb.drop();
});

describe('app_tenant_id()', () => {
  it('is STABLE, SECURITY INVOKER, and has an explicit search_path of pg_catalog, pg_temp', async () => {
    const { rows } = await owner.query<{ volatile: string; secdef: boolean; config: string[] | null }>(
      `SELECT provolatile::text AS volatile, prosecdef AS secdef, proconfig AS config
         FROM pg_proc WHERE proname = 'app_tenant_id' AND pronamespace = 'public'::regnamespace`,
    );
    expect(rows).toEqual([{ volatile: 's', secdef: false, config: ['search_path=pg_catalog, pg_temp'] }]);
  });

  it('returns NULL, not an error, for a missing, empty or malformed setting, and the uuid for a good one', async () => {
    const good = '11111111-2222-4333-8444-555555555555';
    const cases: [string | null, string | null][] = [
      [null, null],
      ['', null],
      ['not-a-uuid', null],
      ['11111111-2222-4333-8444-55555555555', null],
      [` ${good}`, null],
      [good, good],
      [good.toUpperCase(), good],
    ];
    for (const [setting, expected] of cases) {
      await owner.query('BEGIN');
      try {
        if (setting !== null) await owner.query("SELECT set_config('app.tenant_id', $1, true)", [setting]);
        const { rows } = await owner.query<{ t: string | null }>('SELECT public.app_tenant_id()::text AS t');
        expect(rows[0]?.t, JSON.stringify(setting)).toBe(expected);
      } finally {
        await owner.query('ROLLBACK');
      }
    }
  });
});

describe('policies', () => {
  it('every tenant policy calls the helper inside a sub-select and never reads the setting directly', async () => {
    const { rows } = await owner.query<{ table: string; using: string; check: string }>(
      `SELECT polrelid::regclass::text AS table, pg_get_expr(polqual, polrelid) AS using, pg_get_expr(polwithcheck, polrelid) AS check
         FROM pg_policy WHERE polrelid::regclass::text <> ALL($1) ORDER BY 1`,
      [Object.keys(GLOBAL_TABLES)],
    );
    expect(rows.map((r) => r.table).sort()).toEqual([...TENANT_TABLES].sort());
    for (const r of rows) {
      for (const expr of [r.using, r.check]) {
        expect(expr, r.table).toMatch(/\(\s*SELECT app_tenant_id\(\) AS app_tenant_id\)/);
        expect(expr, r.table).not.toMatch(/current_setting/i);
      }
    }
  });
});
