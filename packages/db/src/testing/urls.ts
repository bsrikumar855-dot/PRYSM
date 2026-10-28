/** Name of the migrated template every test database is cloned from (created by the dev/CI init script). */
export const TEMPLATE_DATABASE = 'prysm_template';

/** Every database the harness creates starts with this, so the sweeper never touches anything else. */
export const TEST_DATABASE_PREFIX = 'prysm_t_';

const MAX_IDENTIFIER_LENGTH = 63;

/** Returns `url` with its database name replaced by `database`; credentials, host and query are kept. */
export function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${encodeURIComponent(database)}`;
  return parsed.toString();
}

/**
 * Builds a unique database name: `prysm_t_<epoch seconds>_<suite>_<random>`. The timestamp lets the
 * sweeper find leftovers from crashed runs, because Postgres does not record when a database was created.
 */
export function testDatabaseName(suite: string, nowMs: number, randomHex: string): string {
  const cleanSuite =
    suite
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 24) || 'suite';
  if (!/^[0-9a-f]{6,}$/.test(randomHex)) throw new TypeError('randomHex must be at least 6 hex characters');
  const name = `${TEST_DATABASE_PREFIX}${String(Math.floor(nowMs / 1000))}_${cleanSuite}_${randomHex}`;
  if (name.length > MAX_IDENTIFIER_LENGTH) throw new RangeError(`database name too long: ${name}`);
  return name;
}

/**
 * Creation time in epoch milliseconds parsed from a harness database name, or null if it isn't one. `prefix` defaults to the
 * harness prefix; a test that needs databases the default sweep cannot see passes its own (see `isSweepPrefix`).
 */
export function testDatabaseCreatedAtMs(name: string, prefix: string = TEST_DATABASE_PREFIX): number | null {
  if (!name.startsWith(prefix)) return null;
  const match = /^(\d{9,11})_/.exec(name.slice(prefix.length));
  return match?.[1] ? Number(match[1]) * 1000 : null;
}

/** True for `prysm_<lowercase words>_`: the only shape of prefix a scoped sweep accepts, so it can never reach other databases. */
export function isSweepPrefix(prefix: string): boolean {
  return /^prysm_[a-z0-9_]*[a-z0-9]_$/.test(prefix) && prefix !== 'prysm_template_';
}
