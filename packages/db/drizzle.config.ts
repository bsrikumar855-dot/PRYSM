import { existsSync } from 'node:fs';
import { defineConfig } from 'drizzle-kit';

const envFile = new URL('../../.env', import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);

// Migrations run as the table owner only (ADR-0003, ADR-0007). Runtime roles never run DDL.
const url = process.env['DATABASE_URL_OWNER'];

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
  ...(url ? { dbCredentials: { url } } : {}),
});
