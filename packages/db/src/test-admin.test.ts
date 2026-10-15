import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './testing/index.ts';
import { withDatabase } from './testing/urls.ts';

// prysm_test_admin exists only to create and drop test databases (dev and CI). These tests prove it is
// powerless apart from that and that nothing a service runs can reach it.
const APP_ROLES = ['prysm_app', 'prysm_platform', 'prysm_gateway_outbox'];
const ROLE = 'prysm_test_admin';

let db: TestDatabase;
let owner: pg.Client;

beforeAll(async () => {
  db = await createTestDatabase({ suite: 'test_admin' });
  owner = new pg.Client({ connectionString: db.ownerUrl });
  await owner.connect();
});

afterAll(async () => {
  await owner.end();
  await db.drop();
});

describe('prysm_test_admin has exactly the powers it needs', () => {
  it('is NOSUPERUSER NOBYPASSRLS NOREPLICATION NOCREATEROLE, and can create databases', async () => {
    const { rows } = await owner.query(
      'SELECT rolsuper, rolbypassrls, rolreplication, rolcreaterole, rolcreatedb, rolcanlogin FROM pg_roles WHERE rolname = $1',
      [ROLE],
    );
    expect(rows).toEqual([
      {
        rolsuper: false,
        rolbypassrls: false,
        rolreplication: false,
        rolcreaterole: false,
        rolcreatedb: true,
        rolcanlogin: true,
      },
    ]);
  });

  it('is in no role and has no member, so it inherits and lends nothing', async () => {
    const { rows } = await owner.query<{ n: string }>(
      `SELECT count(*) AS n FROM pg_auth_members m
         JOIN pg_roles r ON r.oid IN (m.roleid, m.member, m.grantor) WHERE r.rolname = $1`,
      [ROLE],
    );
    expect(Number(rows[0]?.n)).toBe(0);
  });

  it('is not a member of, and cannot be assumed by, any runtime role', async () => {
    for (const role of APP_ROLES) {
      const { rows } = await owner.query<{ a: boolean; b: boolean }>(
        "SELECT pg_has_role($1, $2, 'member') AS a, pg_has_role($2, $1, 'member') AS b",
        [role, ROLE],
      );
      expect(rows[0]).toEqual({ a: false, b: false });
    }
    const app = new pg.Client({ connectionString: db.appUrl });
    await app.connect();
    try {
      await expect(app.query(`SET ROLE ${ROLE}`)).rejects.toThrow(/permission denied/);
    } finally {
      await app.end();
    }
  });

  it('owns no object inside a database it created, and cannot create or read anything there', async () => {
    const { rows } = await owner.query<{ n: string }>(
      `SELECT (SELECT count(*) FROM pg_class c WHERE c.relowner = r.oid)
            + (SELECT count(*) FROM pg_namespace n WHERE n.nspowner = r.oid)
            + (SELECT count(*) FROM pg_proc p WHERE p.proowner = r.oid)
            + (SELECT count(*) FROM pg_type t WHERE t.typowner = r.oid) AS n
         FROM pg_roles r WHERE r.rolname = $1`,
      [ROLE],
    );
    expect(Number(rows[0]?.n)).toBe(0);
    const { rows: priv } = await owner.query<{ create: boolean }>(
      "SELECT has_schema_privilege($1, 'public', 'CREATE') AS create",
      [ROLE],
    );
    expect(priv[0]).toEqual({ create: false });

    const admin = new pg.Client({
      connectionString: withDatabase(process.env['DATABASE_URL_TEST_ADMIN'] ?? '', db.name),
    });
    await admin.connect();
    try {
      await expect(admin.query('SELECT 1 FROM drizzle.__drizzle_migrations')).rejects.toThrow(/permission denied/);
      await expect(admin.query('CREATE TABLE public.nope (id int)')).rejects.toThrow(/permission denied/);
    } finally {
      await admin.end();
    }
  });
});

describe('nothing a service runs can reach prysm_test_admin', () => {
  const root = new URL('../../../', import.meta.url);
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  const mentions = (path: string): boolean =>
    /prysm_test_admin|TEST_ADMIN/.test(readFileSync(new URL(path, root), 'utf8'));

  it('is mentioned only by the dev/CI init script, the harness, its tests, CI, env example and docs', () => {
    const allowed = [
      /^infra\/docker\/postgres\/init\/10-test-harness\.sql$/,
      /^packages\/db\/src\/(test-admin\.test\.ts|testing\/)/,
      /^\.github\/workflows\/ci\.yml$/,
      /^\.env\.example$/,
      /^docs\//,
      /^CLAUDE\.md$/,
    ];
    const offenders = files
      .filter((path) => !/\.(png|jpg|ico|woff2?)$/.test(path))
      .filter(mentions)
      .filter((path) => !allowed.some((re) => re.test(path)));
    expect(offenders).toEqual([]);
  });

  it('is not created by any migration, compose file, Dockerfile, service env or application source', () => {
    const productionPaths = files.filter(
      (path) =>
        path.startsWith('packages/db/migrations/') ||
        /^infra\/docker\/(compose|.*Dockerfile)/.test(path) ||
        /(^|\/)service\.env$/.test(path) ||
        /^apps\/[^/]+\/src\//.test(path) ||
        path.startsWith('infra/helm/') ||
        path.startsWith('infra/terraform/'),
    );
    expect(productionPaths.length).toBeGreaterThan(0);
    expect(productionPaths.filter(mentions)).toEqual([]);
  });

  it('is only ever read from the environment by the harness', () => {
    const readers = files
      .filter((path) => /\.(ts|tsx|mjs|js)$/.test(path))
      .filter((path) => readFileSync(new URL(path, root), 'utf8').includes('DATABASE_URL_TEST_ADMIN'));
    expect(readers.every((path) => /^packages\/db\/src\/(test-admin\.test\.ts|testing\/)/.test(path))).toBe(true);
  });
});
