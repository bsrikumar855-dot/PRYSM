import { describe, expect, it } from 'vitest';
import { allowlistFields } from './logger.ts';
import { captureLogger } from './test-helpers.ts';

const CANARY = 'CANARY-PAN-ABCDE1234F';

describe('logger allowlist', () => {
  it('drops non-allow-listed fields and keeps only their names', () => {
    expect(allowlistFields({ tenant_id: 't1', prompt: CANARY, body: { x: CANARY } })).toEqual({
      tenant_id: 't1',
      dropped_fields: ['prompt', 'body'],
    });
  });

  it('never writes a payload value, including nested and child-logger bindings', () => {
    const { logger, raw, lines } = captureLogger();
    logger.info({ request_id: 'r1', prompt: CANARY, messages: [{ content: CANARY }] }, 'call');
    logger.child({ tenant_id: 't1' }).warn({ response: CANARY }, 'resp');
    expect(raw()).not.toContain(CANARY);
    const [first, second] = lines();
    expect(first).toMatchObject({ service: 'test', level: 'info', request_id: 'r1', dropped_fields: ['prompt', 'messages'] });
    expect(second).toMatchObject({ level: 'warn', tenant_id: 't1', dropped_fields: ['response'] });
    expect(typeof first?.['time']).toBe('string');
  });
});
