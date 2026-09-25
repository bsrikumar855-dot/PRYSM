import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { baseEnv, loadConfig } from './config.ts';

describe('loadConfig', () => {
  it('applies defaults and coerces numbers', () => {
    const cfg = loadConfig(baseEnv, { SERVICE_NAME: 'api', PORT: '4000' });
    expect(cfg).toMatchObject({
      SERVICE_NAME: 'api',
      PORT: 4000,
      HOST: '0.0.0.0',
      LOG_LEVEL: 'info',
      SHUTDOWN_DRAIN_DELAY_MS: 0,
    });
  });

  it('lists every problem and refuses to start', () => {
    expect(() => loadConfig(baseEnv, { PORT: '70000', LOG_LEVEL: 'loud' })).toThrow(
      /SERVICE_NAME[\s\S]*PORT[\s\S]*LOG_LEVEL/,
    );
  });

  it('supports service-specific extensions', () => {
    const schema = baseEnv.extend({ DATABASE_URL: z.url() });
    expect(() => loadConfig(schema, { SERVICE_NAME: 'api', PORT: '1', DATABASE_URL: 'nope' })).toThrow(/DATABASE_URL/);
  });
});
