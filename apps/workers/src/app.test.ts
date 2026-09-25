import { createPool } from '@prysm/db';
import { createLogger } from '@prysm/platform';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { workersEnv, buildWorkers } from './app.ts';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set. Run pnpm infra:up and see .env.example.`);
  return v;
}

const logger = createLogger({ service: 'workers-test', level: 'silent' });
const pool = createPool({ connectionString: required('DATABASE_URL_APP'), applicationName: 'prysm-workers-test' });
const valkey = new Redis(required('VALKEY_URL'), { enableOfflineQueue: false, maxRetriesPerRequest: 1 });
const deadValkey = new Redis('redis://127.0.0.1:1', { enableOfflineQueue: false, maxRetriesPerRequest: 0, lazyConnect: true });
deadValkey.on('error', () => undefined);

beforeAll(async () => {
  if (valkey.status !== 'ready') await new Promise((resolve) => valkey.once('ready', resolve));
});

afterAll(async () => {
  await pool.end();
  valkey.disconnect();
  deadValkey.disconnect();
});

describe('workers readiness', () => {
  it('is ready against real Postgres (as prysm_app) and Valkey', async () => {
    const { app } = buildWorkers({ logger, pool, valkey });
    const res = await app.inject({ url: '/readyz' });
    expect(res.json()).toEqual({
      status: 'ready',
      checks: [
        { name: 'postgres', ok: true },
        { name: 'valkey', ok: true },
      ],
    });
  });

  it('is not ready when Valkey is unreachable', async () => {
    const { app } = buildWorkers({ logger, pool, valkey: deadValkey });
    const res = await app.inject({ url: '/readyz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ checks: [{ name: 'postgres', ok: true }, { name: 'valkey', ok: false }] });
  });
});

describe('workers config', () => {
  it('requires database and valkey URLs', () => {
    const r = workersEnv.safeParse({ SERVICE_NAME: 'workers', PORT: '4200' });
    expect(r.success).toBe(false);
  });
});
