import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      include: ['src/**'],
      exclude: ['src/**/*.test.ts'],
      thresholds: { lines: 90, branches: 85 },
    },
  },
});
