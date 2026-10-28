import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestDatabase, suiteScope, sweepStaleTestDatabases, type TestDatabase } from './index.ts';
import { TEMPLATE_DATABASE, withDatabase } from './urls.ts';

const created: TestDatabase[] = [];
async function make(suite: string): Promise<TestDatabase> {
  const db = await createTestDatabase({ suite });
  created.push(db);
  return db;
}

async function scalar(url: string, sql: string): Promise<unknown> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query<Record<string, unknown>>(sql);
    return Object.values(rows[0] ?? {})[0];
  } finally {
    await client.end();
  }
}

afterAll(async () => {
  await Promise.all(created.map((db) => db.drop()));
});

describe('template-database harness', () => {
  it('clones the migrated template, reachable as both runtime roles', async () => {
    const db = await make('clone');
    expect(
      Number(await scalar(db.ownerUrl, 'SELECT count(*) FROM drizzle.__drizzle_migrations')),
    ).toBeGreaterThanOrEqual(1);
    expect(await scalar(db.appUrl, 'SELECT current_user')).toBe('prysm_app');
    expect(await scalar(db.ownerUrl, 'SELECT current_database()')).toBe(db.name);
  });

  it('gives each suite its own database: a write in one is invisible in the other', async () => {
    const [a, b] = await Promise.all([make('iso_a'), make('iso_b')]);
    expect(a.name).not.toBe(b.name);
    await scalar(a.ownerUrl, 'CREATE TABLE public.only_in_a (id int)');
    expect(await scalar(a.ownerUrl, "SELECT to_regclass('public.only_in_a') IS NOT NULL")).toBe(true);
    expect(await scalar(b.ownerUrl, "SELECT to_regclass('public.only_in_a') IS NOT NULL")).toBe(false);
  });

  it('does not touch the template or the shared dev database', async () => {
    const db = await make('untouched');
    await scalar(db.ownerUrl, 'CREATE TABLE public.scratch (id int)');
    const template = withDatabase(db.ownerUrl, TEMPLATE_DATABASE);
    expect(await scalar(template, "SELECT to_regclass('public.scratch') IS NOT NULL")).toBe(false);
  });

  it('drop removes the database once its connections are closed, and twice is fine', async () => {
    const db = await createTestDatabase({ suite: 'drop' });
    const client = new pg.Client({ connectionString: db.ownerUrl });
    await client.connect();
    await client.end();
    await db.drop();
    await db.drop();
    await expect(scalar(db.ownerUrl, 'SELECT 1')).rejects.toThrow(/does not exist/);
  });

  it('refuses to drop under a live connection from another role, with a clear message', async () => {
    const db = await createTestDatabase({ suite: 'live' });
    const lingering = new pg.Client({ connectionString: db.ownerUrl });
    await lingering.connect();
    try {
      await expect(db.drop()).rejects.toThrow(/Close every pool and client/);
    } finally {
      await lingering.end();
    }
    await db.drop();
  });

  // These fixtures live under their own prefix. The default sweep, which every other suite runs on its first
  // createTestDatabase, matches only prysm_t_, so it can never drop a fixture while a test here is using it (T-004).
  const SCOPE = 'prysm_sweeptest_';
  const fixtureName = (label: string, ageMs: number, hex: string) =>
    `${SCOPE}${String(Math.floor((Date.now() - ageMs) / 1000))}_${label}_${hex}`;
  const exists = async (admin: pg.Client, name: string) =>
    (await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])).rowCount === 1;

  it('skips an old database that still has an open connection, then drops it once idle', async () => {
    const admin = new pg.Client({ connectionString: process.env['DATABASE_URL_TEST_ADMIN'] });
    await admin.connect();
    const busy = fixtureName('busy', 2 * 3600_000, 'cccccc');
    try {
      await admin.query(`CREATE DATABASE ${admin.escapeIdentifier(busy)} TEMPLATE ${TEMPLATE_DATABASE}`);
      const open = new pg.Client({ connectionString: withDatabase(process.env['DATABASE_URL_OWNER'] ?? '', busy) });
      await open.connect();
      expect(await sweepStaleTestDatabases(undefined, undefined, SCOPE)).not.toContain(busy);
      expect(await exists(admin, busy)).toBe(true);
      await open.end();
      expect(await sweepStaleTestDatabases(undefined, undefined, SCOPE)).toContain(busy);
      expect(await exists(admin, busy)).toBe(false);
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS ${admin.escapeIdentifier(busy)} WITH (FORCE)`);
      await admin.end();
    }
  });

  it('sweeps only old databases under its prefix, and the default sweep leaves a scoped fixture alone', async () => {
    const admin = new pg.Client({ connectionString: process.env['DATABASE_URL_TEST_ADMIN'] });
    await admin.connect();
    const old = fixtureName('old', 2 * 3600_000, 'aaaaaa');
    const fresh = fixtureName('new', 0, 'bbbbbb');
    try {
      await admin.query(`CREATE DATABASE ${admin.escapeIdentifier(old)} TEMPLATE ${TEMPLATE_DATABASE}`);
      await admin.query(`CREATE DATABASE ${admin.escapeIdentifier(fresh)} TEMPLATE ${TEMPLATE_DATABASE}`);
      expect(await sweepStaleTestDatabases()).not.toContain(old);
      expect(await exists(admin, old)).toBe(true);
      const dropped = await sweepStaleTestDatabases(undefined, undefined, SCOPE);
      expect(dropped).toContain(old);
      expect(dropped).not.toContain(fresh);
      expect(await exists(admin, old)).toBe(false);
      expect(await exists(admin, fresh)).toBe(true);
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS ${admin.escapeIdentifier(fresh)} WITH (FORCE)`);
      await admin.query(`DROP DATABASE IF EXISTS ${admin.escapeIdentifier(old)} WITH (FORCE)`);
      await admin.end();
    }
  });

  it('refuses a sweep prefix that could reach other databases', async () => {
    for (const bad of ['', 'prysm_', 'prysm_template_', 'x_'])
      await expect(sweepStaleTestDatabases(undefined, undefined, bad), bad).rejects.toThrow(/not a valid sweep prefix/);
  });
});

describe('suiteScope', () => {
  it('returns distinct tenant-shaped prefixes', () => {
    const a = suiteScope();
    const b = suiteScope();
    expect(a.tenantId).not.toBe(b.tenantId);
    expect(a.valkeyPrefix).toBe(`t:${a.tenantId}:`);
    expect(a.objectPrefix).toBe(`tenants/${a.tenantId}/`);
  });
});
