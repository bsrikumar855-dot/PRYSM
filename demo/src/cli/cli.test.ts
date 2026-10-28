import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { canonicalize } from '../evidence/canonical.ts';
import { GENESIS_PREV_HASH, anchorOf, buildRecord, hashRecord, type ChainRecord } from '../evidence/chain.ts';
import { exportPack } from '../evidence/pack.ts';

// The offline verifier is a separate process that reads two files and nothing else: no database, no network.
const dir = mkdtempSync(join(tmpdir(), 'demo-cli-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function chain(n: number): ChainRecord[] {
  const out: ChainRecord[] = [];
  let prev = GENESIS_PREV_HASH;
  for (let i = 0; i < n; i += 1) {
    const r = buildRecord(i, prev, {
      type: 'e',
      actor: 'a',
      ts: '2026-10-28T10:00:00Z',
      data: { i, decision: 'deny' },
    });
    out.push(r);
    prev = r.record_hash;
  }
  return out;
}

function run(args: string[]): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, [new URL('./verify.ts', import.meta.url).pathname, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '' },
  });
  return { status: r.status, out: r.stdout + r.stderr };
}

const write = (name: string, value: unknown): string => {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
};

describe('verify CLI (offline)', () => {
  it('exits 0 for an intact pack, with and without the anchor', () => {
    const c = chain(4);
    const pack = write('ok.json', exportPack(c));
    const anchor = write('ok-anchor.json', anchorOf(c));
    expect(run(['--pack', pack])).toMatchObject({ status: 0 });
    const withAnchor = run(['--pack', pack, '--anchor', anchor]);
    expect(withAnchor.status).toBe(0);
    expect(withAnchor.out).toContain('matches the anchor');
  });

  it('exits 1 and names the first bad index when a record was edited', () => {
    const c = chain(4);
    const pack = exportPack(c);
    const target = pack.records[2] as { canonical: string };
    target.canonical = canonicalize({ ...(JSON.parse(target.canonical) as object), decision: 'allow' });
    const result = run(['--pack', write('bad.json', pack)]);
    expect(result.status).toBe(1);
    expect(result.out).toContain('index 2');
    expect(result.out).toContain('hash-mismatch');
  });

  it('a fully rewritten pack passes alone and fails against the anchor', () => {
    const c = chain(4);
    const anchor = write('rw-anchor.json', anchorOf(c));
    const rewritten: ChainRecord[] = [];
    let prev = GENESIS_PREV_HASH;
    for (const r of c) {
      const doc = JSON.parse(r.canonical) as Record<string, unknown>;
      if (r.seq === 1) doc['actor'] = 'insider';
      const canonical = canonicalize(doc);
      const record_hash = hashRecord(prev, canonical);
      rewritten.push({ seq: r.seq, prev_hash: prev, record_hash, canonical });
      prev = record_hash;
    }
    const pack = write('rw.json', exportPack(rewritten));
    expect(run(['--pack', pack]).status).toBe(0);
    const anchored = run(['--pack', pack, '--anchor', anchor]);
    expect(anchored.status).toBe(1);
    expect(anchored.out).toContain('anchor-mismatch');
  });

  it('prints machine-readable output with --json', () => {
    const result = run(['--pack', write('json.json', exportPack(chain(2))), '--json']);
    expect(JSON.parse(result.out.trim())).toMatchObject({ ok: true, length: 2, anchored: false });
  });
});
