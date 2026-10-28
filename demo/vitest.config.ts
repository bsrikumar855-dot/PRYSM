import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// DEMO-ONLY database tests clone the migrated template like the @prysm/db suites do (`pnpm infra:up`, `pnpm db:migrate`,
// `pnpm db:template`). CI sets the environment directly.
const envFile = new URL('../.env', import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);

export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 30_000,
    coverage: {
      include: ['src/**'],
      exclude: ['src/**/*.test.ts', 'src/cli/**', 'src/gateway/main.ts', 'src/test-support/**'],
      thresholds: { lines: 90, branches: 85 },
    },
  },
});
