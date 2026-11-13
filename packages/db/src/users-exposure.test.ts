import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDbOnPool, type Db } from './db.ts';
import { createPool } from './pool.ts';
import { TENANT_TABLES, USERS_COLUMN_CLASSES } from './tables.ts';
import { createTestDatabase, type TestDatabase } from './testing/index.ts';
import { provisionTenant } from './tenancy.ts';

// F-49. `users` is a global table (ADR-0013), but it holds the password salt and tag, so it is split by role:
// prysm_app (every tenant request) reads four non-secret columns of the users who belong to the current tenant, and
// can write nothing; prysm_identity (withGlobal only) reads and writes the rest and holds nothing on any tenant table.
let testDb: TestDatabase;
let pool: pg.Pool;
let identityPool: pg.Pool;
let owner: pg.Client;
let db: Db;

const emails = {
  a: `a-${randomUUID()}@example.test`,
  a2: `a2-${randomUUID()}@example.test`,
  b: `b-${randomUUID()}@example.test`,
  stranger: `s-${randomUUID()}@example.test`,
};
const ids = { a: '', a2: '', b: '', stranger: '' };
let tenantA = '';
let tenantB = '';

const SAFE = USERS_COLUMN_CLASSES.safe;
const SECRET = USERS_COLUMN_CLASSES.secret;
const DENIED = /permission denied/;

async function newUser(email: string): Promise<string> {
  const { rows } = await identityPool.query<{ id: string }>(
    `INSERT INTO users (email, password_algorithm, password_memory_kib, password_passes, password_parallelism, password_salt, password_tag)
     VALUES ($1, 'argon2id', 19456, 2, 1, $2, $3) RETURNING id`,
    [email, randomBytes(16), randomBytes(32)],
  );
  return (rows[0] as { id: string }).id;
}

beforeAll(async () => {
  testDb = await createTestDatabase({ suite: 'users_exposure' });
  pool = createPool({ connectionString: testDb.appUrl, applicationName: 'prysm-users-test', max: 3 });
  identityPool = createPool({ connectionString: testDb.identityUrl, applicationName: 'prysm-users-identity', max: 2 });
  db = createDbOnPool(pool, identityPool);
  owner = new pg.Client({ connectionString: testDb.ownerUrl });
  await owner.connect();
  for (const key of ['a', 'a2', 'b', 'stranger'] as const) ids[key] = await newUser(emails[key]);
  tenantA = (await provisionTenant(db, { slug: `ua-${randomUUID().slice(0, 8)}`, name: 'A', ownerUserId: ids.a }))
    .tenantId;
  tenantB = (await provisionTenant(db, { slug: `ub-${randomUUID().slice(0, 8)}`, name: 'B', ownerUserId: ids.b }))
    .tenantId;
  // A second member of tenant A, so "only current-tenant members" is more than "only the owner".
  await db.withTenant(tenantA, (tx) =>
    tx.query("INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'engineer')", [tenantA, ids.a2]),
  );
});

afterAll(async () => {
  await owner.end();
  await Promise.all([pool.end(), identityPool.end()]);
  await testDb.drop();
});

describe('how users is protected at the database level', () => {
  it('has RLS enabled and forced, one SELECT policy for prysm_app and one policy for prysm_identity', async () => {
    const { rows } = await owner.query<{ rls: boolean; forced: boolean }>(
      "SELECT relrowsecurity AS rls, relforcerowsecurity AS forced FROM pg_class WHERE oid = 'public.users'::regclass",
    );
    expect(rows[0]).toEqual({ rls: true, forced: true });
    const { rows: policies } = await owner.query<{ name: string; cmd: string; roles: string[]; qual: string | null }>(
      `SELECT polname AS name, polcmd AS cmd,
              ARRAY(SELECT rolname FROM pg_roles WHERE oid = ANY(polroles))::text[] AS roles,
              pg_get_expr(polqual, polrelid) AS qual
         FROM pg_policy WHERE polrelid = 'public.users'::regclass ORDER BY polname`,
    );
    expect(policies.map((p) => ({ name: p.name, cmd: p.cmd, roles: p.roles }))).toEqual([
      { name: 'users_identity_all', cmd: '*', roles: ['prysm_identity'] },
      { name: 'users_member_select', cmd: 'r', roles: ['prysm_app'] },
    ]);
    const member = policies.find((p) => p.name === 'users_member_select');
    expect(member?.qual).toContain('memberships');
    expect(member?.qual).toContain('app_tenant_id');
  });

  it('the table owner is subject to it too: with no policy for the owner, it sees no user', async () => {
    const { rows } = await owner.query<{ n: string }>('SELECT count(*) AS n FROM users');
    expect(Number(rows[0]?.n)).toBe(0);
    await expect(owner.query("INSERT INTO users (email) VALUES ('owner-insert@example.test')")).rejects.toThrow(
      /row-level security/,
    );
  });
});

describe('every users column is classified safe or secret, and the grants follow the classes', () => {
  it('the classes cover the catalog exactly: no unclassified column, no column in both classes', async () => {
    const { rows } = await owner.query<{ attname: string }>(
      `SELECT attname FROM pg_attribute WHERE attrelid = 'public.users'::regclass AND attnum > 0 AND NOT attisdropped ORDER BY 1`,
    );
    const catalog = rows.map((r) => r.attname);
    expect([...SAFE, ...SECRET].sort()).toEqual(catalog);
    expect(SAFE.filter((c) => (SECRET as readonly string[]).includes(c))).toEqual([]);
  });

  it('prysm_app can SELECT exactly the safe columns, and no secret column', async () => {
    const { rows } = await owner.query<{ attname: string; ok: boolean }>(
      `SELECT attname, has_column_privilege('prysm_app', 'public.users', attname, 'SELECT') AS ok
         FROM pg_attribute WHERE attrelid = 'public.users'::regclass AND attnum > 0 AND NOT attisdropped ORDER BY 1`,
    );
    expect(rows.filter((r) => r.ok).map((r) => r.attname)).toEqual([...SAFE]);
    for (const secret of SECRET) expect(rows.find((r) => r.attname === secret)?.ok, secret).toBe(false);
  });

  it('prysm_app holds no INSERT, UPDATE or REFERENCES on any users column', async () => {
    const { rows } = await owner.query<{ attname: string }>(
      `SELECT attname FROM pg_attribute WHERE attrelid = 'public.users'::regclass AND attnum > 0 AND NOT attisdropped
          AND has_column_privilege('prysm_app', 'public.users', attname, 'INSERT, UPDATE, REFERENCES')`,
    );
    expect(rows).toEqual([]);
  });
});

describe('prysm_app inside withTenant', () => {
  it('cannot read any password column, by name or through SELECT *', async () => {
    for (const column of SECRET)
      await expect(
        db.withTenant(tenantA, (tx) => tx.query(`SELECT ${column} FROM users`)),
        column,
      ).rejects.toThrow(DENIED);
    await expect(db.withTenant(tenantA, (tx) => tx.query('SELECT * FROM users'))).rejects.toThrow(DENIED);
    await expect(
      db.withTenant(tenantA, (tx) => tx.query('SELECT (password_salt IS NOT NULL) AS has_salt FROM users')),
    ).rejects.toThrow(DENIED);
  });

  it('sees only the users who are members of the current tenant, and only the safe columns', async () => {
    const seen = await db.withTenant(tenantA, (tx) =>
      tx.query<{ id: string; email: string }>(
        'SELECT id, email, email_verified_at, created_at FROM users ORDER BY email',
      ),
    );
    expect(seen.rows.map((r) => r.email).sort()).toEqual([emails.a, emails.a2].sort());
    const other = await db.withTenant(tenantB, (tx) => tx.query<{ email: string }>('SELECT email FROM users'));
    expect(other.rows.map((r) => r.email)).toEqual([emails.b]);
  });

  it('cannot look a non-member up by id or by email, and a join to memberships adds nothing', async () => {
    const byId = await db.withTenant(tenantA, (tx) => tx.query('SELECT 1 FROM users WHERE id = $1', [ids.b]));
    const byEmail = await db.withTenant(tenantA, (tx) =>
      tx.query('SELECT 1 FROM users WHERE email = $1', [emails.stranger]),
    );
    expect(byId.rows).toEqual([]);
    expect(byEmail.rows).toEqual([]);
    const joined = await db.withTenant(tenantA, (tx) =>
      tx.query<{ email: string }>('SELECT u.email FROM users u JOIN memberships m ON m.user_id = u.id ORDER BY 1'),
    );
    expect(joined.rows.map((r) => r.email).sort()).toEqual([emails.a, emails.a2].sort());
  });

  it('sees no user at all when no tenant is set', async () => {
    const { rows } = await pool.query('SELECT id FROM users');
    expect(rows).toEqual([]);
  });

  it('cannot write users: no INSERT, UPDATE or DELETE, even on a row it can see', async () => {
    const attempts = [
      "INSERT INTO users (email) VALUES ('evil@example.test')",
      "UPDATE users SET email = 'x@example.test'",
      'UPDATE users SET password_tag = NULL',
      'DELETE FROM users',
      'TRUNCATE users',
    ];
    for (const sql of attempts)
      await expect(
        db.withTenant(tenantA, (tx) => tx.query(sql)),
        sql,
      ).rejects.toThrow(DENIED);
    const { rows } = await identityPool.query<{ n: string }>('SELECT count(*) AS n FROM users');
    expect(Number(rows[0]?.n)).toBe(4);
  });
});

describe('prysm_identity (withGlobal)', () => {
  it('reads and writes the password columns, which is the whole point of the role', async () => {
    const found = await db.withGlobal((tx) =>
      tx.query<{ has_hash: boolean }>(
        'SELECT (password_salt IS NOT NULL AND password_tag IS NOT NULL) AS has_hash FROM users WHERE email = $1',
        [emails.stranger],
      ),
    );
    expect(found.rows).toEqual([{ has_hash: true }]);
    const updated = await db.withGlobal((tx) =>
      tx.query('UPDATE users SET failed_logins = failed_logins + 1 WHERE email = $1', [emails.stranger]),
    );
    expect(updated.rowCount).toBe(1);
  });

  it('can neither delete users nor change their id', async () => {
    await expect(db.withGlobal((tx) => tx.query('DELETE FROM users'))).rejects.toThrow(DENIED);
    await expect(db.withGlobal((tx) => tx.query('UPDATE users SET id = gen_random_uuid()'))).rejects.toThrow(DENIED);
  });

  it('holds no privilege of any kind on any tenant table, table-level or column-level', async () => {
    const { rows } = await owner.query<{ what: string }>(
      `SELECT c.relname AS what FROM pg_class c
        WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY($1)
          AND (has_table_privilege('prysm_identity', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
               OR EXISTS (SELECT 1 FROM pg_attribute att WHERE att.attrelid = c.oid AND att.attnum > 0 AND NOT att.attisdropped
                          AND has_column_privilege('prysm_identity', c.oid, att.attnum, 'SELECT, INSERT, UPDATE, REFERENCES')))`,
      [[...TENANT_TABLES]],
    );
    expect(rows).toEqual([]);
    for (const table of TENANT_TABLES)
      await expect(identityPool.query(`SELECT * FROM ${table}`), table).rejects.toThrow(DENIED);
  });

  it('has no privilege on the tenant helper function either', async () => {
    const { rows } = await owner.query<{ ok: boolean }>(
      "SELECT has_function_privilege('prysm_identity', 'public.app_tenant_id()', 'EXECUTE') AS ok",
    );
    expect(rows).toEqual([{ ok: false }]);
  });
});
