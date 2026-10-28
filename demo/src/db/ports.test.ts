import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { isPortFree, pickFreePort, portOverrideYaml, writePortOverride } from './ports.ts';

const dir = mkdtempSync(join(tmpdir(), 'demo-ports-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('port selection', () => {
  it('sees a port that is in use as taken and a free one as free', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const busy = typeof address === 'object' && address ? address.port : 0;
    expect(await isPortFree(busy)).toBe(false);
    await new Promise((resolve) => server.close(resolve));
    expect(await isPortFree(busy)).toBe(true);
  });

  it('picks a port that can then be used', async () => {
    const port = await pickFreePort();
    expect(port).toBeGreaterThan(1023);
    expect(await isPortFree(port)).toBe(true);
  });

  it('writes a loopback-only override for the chosen port', () => {
    const path = writePortOverride(31234, join(dir, 'nested', 'compose.ports.yml'));
    const text = readFileSync(path, 'utf8');
    expect(text).toBe(portOverrideYaml(31234));
    expect(text).toContain("ports: !override ['127.0.0.1:31234:5432']");
    expect(text).toContain('DEMO-ONLY');
  });
});
