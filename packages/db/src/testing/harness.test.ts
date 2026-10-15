import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestDatabase, suiteScope, sweepStaleTestDatabases, type TestDatabase } from './index.ts';
import { TEMPLATE_DATABASE, testDatabaseName, withDatabase } from './urls.ts';

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

  it('skips an old database that still has an open connection, then drops it once idle', async () => {
    const admin = new pg.Client({ connectionString: process.env['DATABASE_URL_TEST_ADMIN'] });
    await admin.connect();
    const busy = testDatabaseName('sweep_busy', Date.now() - 2 * 3600_000, 'cccccc');
    try {
      await admin.query(`CREATE DATABASE ${admin.escapeIdentifier(busy)} TEMPLATE ${TEMPLATE_DATABASE}`);
      const open = new pg.Client({ connectionString: withDatabase(process.env['DATABASE_URL_OWNER'] ?? '', busy) });
      await open.connect();
      expect(await sweepStaleTestDatabases()).not.toContain(busy);
      const stillThere = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [busy]);
      expect(stillThere.rowCount).toBe(1);
      await open.end();
      expect(await sweepStaleTestDatabases()).toContain(busy);
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS ${admin.escapeIdentifier(busy)} WITH (FORCE)`);
      await admin.end();
    }
  });

  it('sweeps only old harness databases', async () => {
    const admin = new pg.Client({ connectionString: process.env['DATABASE_URL_TEST_ADMIN'] });
    await admin.connect();
    const old = testDatabaseName('sweep_old', Date.now() - 2 * 3600_000, 'aaaaaa');
    const fresh = testDatabaseName('sweep_new', Date.now(), 'bbbbbb');
    try {
      await admin.query(`CREATE DATABASE ${admin.escapeIdentifier(old)} TEMPLATE ${TEMPLATE_DATABASE}`);
      await admin.query(`CREATE DATABASE ${admin.escapeIdentifier(fresh)} TEMPLATE ${TEMPLATE_DATABASE}`);
      const dropped = await sweepStaleTestDatabases();
      expect(dropped).toContain(old);
      expect(dropped).not.toContain(fresh);
      const { rows } = await admin.query<{ datname: string }>(
        'SELECT datname FROM pg_database WHERE datname = ANY($1)',
        [[old, fresh]],
      );
      expect(rows.map((r) => r.datname)).toEqual([fresh]);
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS ${admin.escapeIdentifier(fresh)} WITH (FORCE)`);
      await admin.query(`DROP DATABASE IF EXISTS ${admin.escapeIdentifier(old)} WITH (FORCE)`);
      await admin.end();
    }
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
