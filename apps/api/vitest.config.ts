import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// Integration tests use the local stack (`pnpm infra:up`). CI sets the env directly.
const envFile = new URL('../../.env', import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);

export default defineConfig({ test: { testTimeout: 15_000 } });
