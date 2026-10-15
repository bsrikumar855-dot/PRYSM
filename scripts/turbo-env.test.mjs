import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { envNames, missingFromPassThrough } from './turbo-env.mjs';

const envExample = [
  '# comment with DATABASE_URL_IGNORED=x',
  'DATABASE_URL_OWNER=postgres://a',
  'DATABASE_URL_EXTRA=postgres://b',
  'VALKEY_URL=redis://c',
  'S3_ENDPOINT=http://d',
  'OTEL_TRACES_EXPORTER=otlp',
  '',
].join('\n');

test('reads assigned names and skips comments', () => {
  assert.deepEqual(envNames(envExample), [
    'DATABASE_URL_OWNER',
    'DATABASE_URL_EXTRA',
    'VALKEY_URL',
    'S3_ENDPOINT',
    'OTEL_TRACES_EXPORTER',
  ]);
});

test('is quiet when every connection variable is passed through', () => {
  const turbo = {
    tasks: { test: { passThroughEnv: ['DATABASE_URL_OWNER', 'DATABASE_URL_EXTRA', 'VALKEY_URL', 'S3_ENDPOINT'] } },
  };
  assert.deepEqual(missingFromPassThrough(envExample, turbo), []);
});

test('names each missing connection variable, and ignores unrelated ones', () => {
  const turbo = { tasks: { test: { passThroughEnv: ['DATABASE_URL_OWNER', 'VALKEY_URL'] } } };
  assert.deepEqual(missingFromPassThrough(envExample, turbo), ['DATABASE_URL_EXTRA', 'S3_ENDPOINT']);
});

test('treats a missing test task or passThroughEnv as everything missing', () => {
  assert.deepEqual(missingFromPassThrough(envExample, { tasks: {} }), [
    'DATABASE_URL_OWNER',
    'DATABASE_URL_EXTRA',
    'VALKEY_URL',
    'S3_ENDPOINT',
  ]);
});

test('accepts a variable listed under env instead of passThroughEnv', () => {
  const turbo = {
    tasks: { test: { env: ['DATABASE_URL_OWNER', 'DATABASE_URL_EXTRA', 'VALKEY_URL', 'S3_ENDPOINT'] } },
  };
  assert.deepEqual(missingFromPassThrough(envExample, turbo), []);
});

test('the real .env.example and turbo.json are in step', () => {
  const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  const missing = missingFromPassThrough(read('.env.example'), JSON.parse(read('turbo.json')));
  assert.deepEqual(
    missing,
    [],
    `add these to tasks.test.passThroughEnv in turbo.json, or turbo hides them from tests in CI: ${missing.join(', ')}`,
  );
});
