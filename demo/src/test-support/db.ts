// DEMO-ONLY (TODO(T-001)). Throwaway test databases for the demo suites. They are cloned from the same migrated template as
// @prysm/db/testing, but under their own prefix and with their own cleanup. The shared harness sweeps every `prysm_t_` database
// older than an hour, which can drop another suite's deliberately old fixture while it runs; demo tests must never take part.
import { randomBytes } from 'node:crypto';
import pg from 'pg';

/** Prefix of every database the demo tests create. It does not match the shared harness's `prysm_t_` sweep. */
export const DEMO_TEST_DB_PREFIX = 'prysm_demo_t_';
const TEMPLATE = 'prysm_template';
const STALE_AFTER_MS = 60 * 60 * 1000;

/** A throwaway database cloned from the migrated template. */
export interface DemoTestDatabase {
  name: string;
  ownerUrl: string;
  appUrl: string;
  /** Drops the database; every pool and client connected to it must be closed first. Safe to call twice. */
  drop(): Promise<void>;
}

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. Start the stack (pnpm infra:up) and copy .env.example to .env.`);
  return value;
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${encodeURIComponent(database)}`;
  return parsed.toString();
}

async function withAdmin<T>(fn: (admin: pg.Client) => Promise<T>): Promise<T> {
  const admin = new pg.Client({
    connectionString: env('DATABASE_URL_TEST_ADMIN'),
    application_name: 'prysm-demo-tests',
  });
  await admin.connect();
  try {
    return await fn(admin);
  } finally {
    await admin.end();
  }
}

/** Parses the creation time out of a demo test database name, or null when the name is not one of ours. */
export function demoTestDbCreatedAtMs(name: string): number | null {
  const match = /^prysm_demo_t_(\d{9,11})_/.exec(name);
  return match?.[1] ? Number(match[1]) * 1000 : null;
}

/** Drops demo test databases older than an hour (left by a crashed run). Only the demo prefix is ever touched; no FORCE. */
export async function sweepStaleDemoTestDatabases(nowMs = Date.now()): Promise<string[]> {
  return withAdmin(async (admin) => {
    const { rows } = await admin.query<{ datname: string }>('SELECT datname FROM pg_database WHERE datname LIKE $1', [
      `${DEMO_TEST_DB_PREFIX.replaceAll('_', '\\_')}%`,
    ]);
    const dropped: string[] = [];
    for (const { datname } of rows) {
      const createdAt = demoTestDbCreatedAtMs(datname);
      if (createdAt === null || nowMs - createdAt < STALE_AFTER_MS) continue;
      try {
        await admin.query(`DROP DATABASE ${admin.escapeIdentifier(datname)}`);
        dropped.push(datname);
      } catch (error) {
        // 55006 = still in use (a run that is still going); 3D000 = another cleanup got there first.
        const code = (error as { code?: string }).code;
        if (code !== '55006' && code !== '3D000') throw error;
      }
    }
    return dropped;
  });
}

/** Creates `prysm_demo_t_<epoch seconds>_<suite>_<random>` as a clone of the migrated template. */
export async function createDemoTestDatabase({ suite }: { suite: string }): Promise<DemoTestDatabase> {
  const ownerBase = env('DATABASE_URL_OWNER');
  const appBase = env('DATABASE_URL_APP');
  await sweepStaleDemoTestDatabases().catch(() => undefined);
  const clean = suite
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .slice(0, 24);
  const name = `${DEMO_TEST_DB_PREFIX}${String(Math.floor(Date.now() / 1000))}_${clean}_${randomBytes(4).toString('hex')}`;
  await withAdmin((admin) => admin.query(`CREATE DATABASE ${admin.escapeIdentifier(name)} TEMPLATE ${TEMPLATE}`));
  return {
    name,
    ownerUrl: withDatabase(ownerBase, name),
    appUrl: withDatabase(appBase, name),
    drop: () =>
      withAdmin((admin) =>
        admin.query(`DROP DATABASE IF EXISTS ${admin.escapeIdentifier(name)} WITH (FORCE)`).then(() => undefined),
      ),
  };
}
