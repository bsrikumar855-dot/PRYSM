import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import {
  TEMPLATE_DATABASE,
  TEST_DATABASE_PREFIX,
  testDatabaseCreatedAtMs,
  testDatabaseName,
  withDatabase,
} from './urls.ts';

/** A throwaway database cloned from the migrated template. */
export interface TestDatabase {
  name: string;
  /** Connection URL for prysm_owner (DDL, seeding). */
  ownerUrl: string;
  /** Connection URL for prysm_app (what the services use at runtime). */
  appUrl: string;
  /** Connection URL for prysm_identity (what `withGlobal` uses; the only role that may touch password columns). */
  identityUrl: string;
  /** Drops the database, closing any connections still open to it. Safe to call twice. */
  drop(): Promise<void>;
}

const SWEEP_AFTER_MS = 60 * 60 * 1000;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. Start the stack (pnpm infra:up) and see .env.example.`);
  return value;
}

async function withAdmin<T>(fn: (admin: pg.Client) => Promise<T>): Promise<T> {
  const admin = new pg.Client({
    connectionString: requiredEnv('DATABASE_URL_TEST_ADMIN'),
    application_name: 'prysm-test-harness',
  });
  await admin.connect();
  try {
    return await fn(admin);
  } finally {
    await admin.end();
  }
}

async function dropDatabase(admin: pg.Client, name: string): Promise<void> {
  try {
    // FORCE only terminates sessions the admin role may signal, i.e. not prysm_owner's or prysm_app's.
    await admin.query(`DROP DATABASE IF EXISTS ${admin.escapeIdentifier(name)} WITH (FORCE)`);
  } catch (error) {
    throw new Error(
      `Could not drop ${name}. Close every pool and client connected to it first (afterAll). ` +
        `Cause: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/** Postgres error code for "database is being accessed by other users". */
const OBJECT_IN_USE = '55006';

/**
 * Drops harness databases older than `maxAgeMs` (left behind by a crashed run) and returns the names it
 * dropped. A database with any open connection is skipped, never forced: it may belong to a run that is
 * still going (a slow CI job, another developer's suite on a shared server). Only names that start with
 * the harness prefix and carry a parseable timestamp are ever touched.
 */
export async function sweepStaleTestDatabases(maxAgeMs = SWEEP_AFTER_MS, nowMs = Date.now()): Promise<string[]> {
  return withAdmin(async (admin) => {
    const { rows } = await admin.query<{ datname: string }>('SELECT datname FROM pg_database WHERE datname LIKE $1', [
      `${TEST_DATABASE_PREFIX.replaceAll('_', '\\_')}%`,
    ]);
    const dropped: string[] = [];
    for (const { datname } of rows) {
      const createdAt = testDatabaseCreatedAtMs(datname);
      if (createdAt === null || nowMs - createdAt < maxAgeMs) continue;
      try {
        // No FORCE: Postgres refuses while anyone is connected, which is exactly the "still in use" check.
        await admin.query(`DROP DATABASE ${admin.escapeIdentifier(datname)}`);
        dropped.push(datname);
      } catch (error) {
        if ((error as { code?: string }).code !== OBJECT_IN_USE) throw error;
      }
    }
    return dropped;
  });
}

let sweptThisProcess: Promise<unknown> | undefined;

/**
 * Creates `prysm_t_<time>_<suite>_<random>` as a clone of the migrated template, so a suite gets a
 * real schema with FORCE ROW LEVEL SECURITY and nothing shared with other suites. Needs
 * DATABASE_URL_TEST_ADMIN (dev and CI only), DATABASE_URL_OWNER and DATABASE_URL_APP, and a template
 * built by `pnpm db:template`.
 */
export async function createTestDatabase({ suite }: { suite: string }): Promise<TestDatabase> {
  const ownerBase = requiredEnv('DATABASE_URL_OWNER');
  const appBase = requiredEnv('DATABASE_URL_APP');
  const identityBase = requiredEnv('DATABASE_URL_IDENTITY');
  sweptThisProcess ??= sweepStaleTestDatabases().catch(() => undefined);
  await sweptThisProcess;

  const name = testDatabaseName(suite, Date.now(), randomBytes(4).toString('hex'));
  await withAdmin(async (admin) => {
    try {
      await admin.query(`CREATE DATABASE ${admin.escapeIdentifier(name)} TEMPLATE ${TEMPLATE_DATABASE}`);
    } catch (error) {
      throw new Error(
        `Could not clone ${TEMPLATE_DATABASE}. Run infra/docker/postgres/init/10-test-harness.sql and \`pnpm db:template\`, ` +
          `and make sure nothing is connected to the template. Cause: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  });

  return {
    name,
    ownerUrl: withDatabase(ownerBase, name),
    appUrl: withDatabase(appBase, name),
    identityUrl: withDatabase(identityBase, name),
    drop: () => withAdmin((admin) => dropDatabase(admin, name)),
  };
}

/**
 * Identifiers that keep one suite's non-Postgres state apart from another's: a random tenant id with
 * the Valkey and object-store prefixes ADR-0007 gives that tenant.
 */
export function suiteScope(): { tenantId: string; valkeyPrefix: string; objectPrefix: string } {
  const tenantId = randomUUID();
  return { tenantId, valkeyPrefix: `t:${tenantId}:`, objectPrefix: `tenants/${tenantId}/` };
}
