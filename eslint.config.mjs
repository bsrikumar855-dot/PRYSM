import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import prysm from './scripts/eslint/prysm-plugin.mjs';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/.next/**', '**/coverage/**', '**/node_modules/**', '**/.venv/**', '**/next-env.d.ts'],
  },
  js.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    extends: [tseslint.configs.strictTypeChecked],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      // Payloads must never reach logs through console; use the platform logger.
      'no-console': 'error',
    },
  },
  {
    // Database boundary (ADR-0003, ADR-0007): only packages/db may touch drivers, pools or raw queries.
    files: ['**/*.ts', '**/*.tsx'],
    plugins: { prysm },
    rules: { 'prysm/no-raw-pool': 'error', 'prysm/db-access-in-with-tenant': 'error' },
  },
  {
    files: ['packages/db/**'],
    rules: { 'prysm/no-raw-pool': 'off', 'prysm/db-access-in-with-tenant': 'off' },
  },
  {
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: { globals: globals.node },
  },
  prettier,
);
