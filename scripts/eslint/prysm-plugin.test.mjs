import { describe, it } from 'node:test';
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import plugin from './prysm-plugin.mjs';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

// The TypeScript parser, as in the real config, so `import type` and inline `type` specifiers parse.
const tester = new RuleTester({
  languageOptions: { parser: tseslint.parser, ecmaVersion: 'latest', sourceType: 'module' },
});

tester.run('prysm/no-raw-pool', plugin.rules['no-raw-pool'], {
  valid: [
    { code: "import { createDb } from '@prysm/db';" },
    { code: "import type { Db, TenantTx } from '@prysm/db';" },
    { code: "import { createTestDatabase } from '@prysm/db/testing';" },
    { code: "import { Redis } from 'ioredis';" },
    { code: "const x = require('node:fs');" },
  ],
  invalid: [
    { code: "import pg from 'pg';", errors: [{ messageId: 'driver' }] },
    { code: "import { Pool } from 'pg';", errors: [{ messageId: 'driver' }] },
    { code: "import type { Pool } from 'pg';", errors: [{ messageId: 'driver' }] },
    { code: "export { Pool } from 'pg';", errors: [{ messageId: 'driver' }] },
    { code: "export * from 'pg-pool';", errors: [{ messageId: 'driver' }] },
    { code: "const pg = require('pg');", errors: [{ messageId: 'driver' }] },
    { code: "const pg = await import('pg');", errors: [{ messageId: 'driver' }] },
    { code: "import postgres from 'postgres';", errors: [{ messageId: 'driver' }] },
    { code: "import { drizzle } from 'drizzle-orm/node-postgres';", errors: [{ messageId: 'driver' }] },
    { code: "import { createPool } from '@prysm/db';", errors: [{ messageId: 'pool' }] },
    { code: "import { createDb, type Pool } from '@prysm/db';", errors: [{ messageId: 'pool' }] },
    { code: "import { PoolClient as C } from '@prysm/db/internal';", errors: [{ messageId: 'pool' }] },
  ],
});

tester.run('prysm/db-access-in-with-tenant', plugin.rules['db-access-in-with-tenant'], {
  valid: [
    { code: 'await db.withTenant(id, async (tx) => { await tx.query("select 1"); });' },
    { code: 'await this.db.withTenant(id, async function (client) { await client.query("select 1"); });' },
    { code: 'await db.withTenant(id, (conn) => conn.query("select 1"));' },
    { code: 'await db.withTenant(id, async (tx) => { const rows = await tx.query("x"); return helper(rows); });' },
    { code: 'await db.ping();' },
    { code: 'const q = request.query.page;' },
    { code: 'await cache.query("x");' },
    { code: 'withTenant(id, async (tx) => { await tx.query("x"); });' },
    { code: 'await db.withGlobal(async (tx) => { await tx.query("select 1 from users"); });' },
  ],
  invalid: [
    { code: 'await db.query("select 1");', errors: [{ messageId: 'outside' }] },
    {
      // withGlobal is a sanctioned callback, but the outer handle inside it is still a bypass.
      code: 'await db.withGlobal(async (tx) => { await db.query("select 1"); await tx.query("ok"); });',
      errors: [{ messageId: 'outside' }],
    },
    { code: 'await pool.query("select 1");', errors: [{ messageId: 'outside' }] },
    { code: 'const c = await pool.connect();', errors: [{ messageId: 'outside' }] },
    { code: 'await this.db.query("select 1");', errors: [{ messageId: 'outside' }] },
    { code: 'await client.execute("select 1");', errors: [{ messageId: 'outside' }] },
    { code: 'await db.transaction(async () => {});', errors: [{ messageId: 'outside' }] },
    {
      // Using the outer handle inside the callback is still a bypass.
      code: 'await db.withTenant(id, async (tx) => { await db.query("select 1"); await tx.query("ok"); });',
      errors: [{ messageId: 'outside' }],
    },
    {
      // The tx name is only allowed inside its own callback.
      code: 'await db.withTenant(id, async (tx) => { await tx.query("ok"); }); await client.query("late");',
      errors: [{ messageId: 'outside' }],
    },
  ],
});
