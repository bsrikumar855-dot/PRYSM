// Applies the migrations to the template database that every test database is cloned from.
// Run after `pnpm db:migrate` and whenever a migration changes: `pnpm db:template`.
import { spawnSync } from 'node:child_process';
import { TEMPLATE_DATABASE, withDatabase } from './urls.ts';

const owner = process.env['DATABASE_URL_OWNER'];
if (!owner) {
  process.stderr.write('DATABASE_URL_OWNER is not set. See .env.example.\n');
  process.exit(1);
}

// The template must have no open connections when a test database is cloned, so the migration
// runs in a child process that has exited by the time this script returns.
const result = spawnSync('pnpm', ['exec', 'drizzle-kit', 'migrate'], {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL_OWNER: withDatabase(owner, TEMPLATE_DATABASE) },
});
if (result.status !== 0) {
  process.stderr.write(
    `Migrating ${TEMPLATE_DATABASE} failed. Was infra/docker/postgres/init/10-test-harness.sql applied?\n`,
  );
  process.exit(result.status ?? 1);
}
process.stdout.write(`${TEMPLATE_DATABASE} is migrated.\n`);
