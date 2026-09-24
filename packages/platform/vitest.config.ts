import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: { include: ['src/**'], exclude: ['src/otel.ts', 'src/test-helpers.ts', 'src/**/*.test.ts'], thresholds: { lines: 90, branches: 85 } },
  },
});
