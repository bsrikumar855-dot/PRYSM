import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// Integration tests against a real Postgres (`pnpm infra:up && pnpm db:migrate`). CI sets the env directly.
const envFile = new URL('../../.env', import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);

export default defineConfig({ test: { fileParallelism: false, testTimeout: 15_000 } });
