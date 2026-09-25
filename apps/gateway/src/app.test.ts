import { createLogger } from '@prysm/platform';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGateway, gatewayEnv } from './app.ts';

const url = process.env['VALKEY_URL'];
if (!url) throw new Error('VALKEY_URL is not set. Run pnpm infra:up and see .env.example.');

const logger = createLogger({ service: 'gateway-test', level: 'silent' });
const valkey = new Redis(url, { enableOfflineQueue: false, maxRetriesPerRequest: 1 });
const deadValkey = new Redis('redis://127.0.0.1:1', { enableOfflineQueue: false, maxRetriesPerRequest: 0, lazyConnect: true });
deadValkey.on('error', () => undefined);

beforeAll(async () => {
  if (valkey.status !== 'ready') await new Promise((resolve) => valkey.once('ready', resolve));
});

afterAll(() => {
  valkey.disconnect();
  deadValkey.disconnect();
});

describe('gateway readiness', () => {
  it('is ready when Valkey answers', async () => {
    const { app } = buildGateway({ logger, valkey });
    expect((await app.inject({ url: '/readyz' })).json()).toEqual({ status: 'ready', checks: [{ name: 'valkey', ok: true }] });
  });

  it('is not ready when Valkey is unreachable', async () => {
    const { app } = buildGateway({ logger, valkey: deadValkey });
    expect((await app.inject({ url: '/readyz' })).statusCode).toBe(503);
  });

  it('requires a Valkey URL', () => {
    expect(gatewayEnv.safeParse({ SERVICE_NAME: 'gateway', PORT: '4100' }).success).toBe(false);
  });
});
