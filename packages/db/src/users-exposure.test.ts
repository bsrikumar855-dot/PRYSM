import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDbOnPool, type Db } from './db.ts';
import { createPool } from './pool.ts';
import { createTestDatabase, type TestDatabase } from './testing/index.ts';
import { provisionTenant } from './tenancy.ts';

// `users` is a global table (ADR-0013): no tenant_id, no RLS. This file pins down what that means for the
// app role TODAY, so the exposure is evidence and not an assumption. See TRACKING F-49 for the proposed fix.
let testDb: TestDatabase;
let pool: pg.Pool;
let owner: pg.Client;
let db: Db;

const emails = {
  a: `a-${randomUUID()}@example.test`,
  b: `b-${randomUUID()}@example.test`,
  stranger: `s-${randomUUID()}@example.test`,
};
let tenantA = '';

async function newUser(email: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_algorithm, password_memory_kib, password_passes, password_parallelism, password_salt, password_tag)
     VALUES ($1, 'argon2id', 19456, 2, 1, $2, $3) RETURNING id`,
    [email, randomBytes(16), randomBytes(32)],
  );
  return (rows[0] as { id: string }).id;
}

beforeAll(async () => {
  testDb = await createTestDatabase({ suite: 'users_exposure' });
  pool = createPool({ connectionString: testDb.appUrl, applicationName: 'prysm-users-test', max: 3 });
  db = createDbOnPool(pool);
  owner = new pg.Client({ connectionString: testDb.ownerUrl });
  await owner.connect();
  const [a, b] = [await newUser(emails.a), await newUser(emails.b)];
  await newUser(emails.stranger); // belongs to no tenant at all
  tenantA = (await provisionTenant(db, { slug: `ua-${randomUUID().slice(0, 8)}`, name: 'A', ownerUserId: a })).tenantId;
  await provisionTenant(db, { slug: `ub-${randomUUID().slice(0, 8)}`, name: 'B', ownerUserId: b });
});

afterAll(async () => {
  await owner.end();
  await pool.end();
  await testDb.drop();
});

describe('how users is protected at the database level today', () => {
  it('has no RLS and no policy, so only grants stand between prysm_app and every row', async () => {
    const { rows } = await owner.query<{ rls: boolean; forced: boolean; policies: string }>(
      `SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
              (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
         FROM pg_class c WHERE c.oid = 'public.users'::regclass`,
    );
    expect(rows[0]).toMatchObject({ rls: false, forced: false });
    expect(Number(rows[0]?.policies)).toBe(0);
  });

  it('grants prysm_app SELECT on every column, including the password salt and tag; nothing for the other runtime roles', async () => {
    const { rows } = await owner.query<{
      salt: boolean;
      tag: boolean;
      email: boolean;
      platform: boolean;
      outbox: boolean;
    }>(
      `SELECT has_column_privilege('prysm_app', 'public.users', 'password_salt', 'SELECT') AS salt,
              has_column_privilege('prysm_app', 'public.users', 'password_tag', 'SELECT') AS tag,
              has_column_privilege('prysm_app', 'public.users', 'email', 'SELECT') AS email,
              has_table_privilege('prysm_platform', 'public.users', 'SELECT') AS platform,
              has_table_privilege('prysm_gateway_outbox', 'public.users', 'SELECT') AS outbox`,
    );
    expect(rows[0]).toEqual({ salt: true, tag: true, email: true, platform: false, outbox: false });
  });
});

describe('users inside withTenant', () => {
  it('KNOWN GAP (F-49): prysm_app can read users who are not members of the tenant, password salt and tag included', async () => {
    const seen = await db.withTenant(tenantA, (tx) =>
      tx.query<{ email: string; has_hash: boolean }>(
        'SELECT email, (password_salt IS NOT NULL AND password_tag IS NOT NULL) AS has_hash FROM users ORDER BY email',
      ),
    );
    const visible = seen.rows.map((r) => r.email);
    expect(visible).toEqual(expect.arrayContaining([emails.a, emails.b, emails.stranger]));
    expect(seen.rows.every((r) => r.has_hash)).toBe(true);
  });

  // The behaviour we want. It fails today, which is the point: it.fails turns green only while the gap exists, and
  // starts failing the day the gap is closed, so whoever fixes it must flip it to a plain `it` (and delete the test above).
  it.fails('DESIRED: SELECT on users inside withTenant returns only current-tenant members, or nothing', async () => {
    const seen = await db.withTenant(tenantA, (tx) => tx.query<{ email: string }>('SELECT email FROM users'));
    const visible = seen.rows.map((r) => r.email);
    expect(visible).not.toContain(emails.b);
    expect(visible).not.toContain(emails.stranger);
  });
});
