import { describe, expect, it } from 'vitest';
import { checkReadiness } from './readiness';

describe('checkReadiness', () => {
  it('is ready when the API liveness endpoint answers 2xx', async () => {
    const calls: string[] = [];
    const fake = ((url: URL) => {
      calls.push(url.toString());
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as typeof fetch;
    expect(await checkReadiness('http://api:4000', fake)).toEqual({
      status: 'ready',
      checks: [{ name: 'api', ok: true }],
    });
    expect(calls).toEqual(['http://api:4000/healthz']);
  });

  it('is not ready on non-2xx or network errors', async () => {
    const down = (() => Promise.resolve(new Response('', { status: 503 }))) as typeof fetch;
    const broken = (() => Promise.reject(new Error('ECONNREFUSED'))) as typeof fetch;
    expect((await checkReadiness('http://api:4000', down)).status).toBe('not_ready');
    expect((await checkReadiness('http://api:4000', broken)).status).toBe('not_ready');
  });
});
