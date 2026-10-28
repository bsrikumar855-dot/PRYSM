import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { advanceAnchor, readAnchor, writeAnchor } from './anchor.ts';
import { canonicalize } from './canonical.ts';
import {
  GENESIS_PREV_HASH,
  anchorOf,
  buildRecord,
  hashRecord,
  sha256Hex,
  verifyChain,
  type ChainRecord,
} from './chain.ts';
import { exportPack, verifyPack } from './pack.ts';

/** A chain of `n` synthetic records. */
function makeChain(n: number): ChainRecord[] {
  const records: ChainRecord[] = [];
  let prev = GENESIS_PREV_HASH;
  for (let i = 0; i < n; i += 1) {
    const r = buildRecord(i, prev, {
      type: 'tool_call.decision',
      actor: 'gateway',
      ts: `2026-10-28T10:00:${String(i).padStart(2, '0')}Z`,
      data: { decision: i % 2 === 0 ? 'deny' : 'allow', tool: `tool_${String(i)}`, amount: i * 100 },
    });
    records.push(r);
    prev = r.record_hash;
  }
  return records;
}

/** Re-hashes records from `from` on after `mutate` changes record `from`, the way an attacker with write access would. */
function rewriteFrom(
  records: ChainRecord[],
  from: number,
  mutate: (doc: Record<string, unknown>) => void,
): ChainRecord[] {
  const out = records.map((r) => ({ ...r }));
  let prev = from === 0 ? GENESIS_PREV_HASH : (out[from - 1] as ChainRecord).record_hash;
  for (let i = from; i < out.length; i += 1) {
    const rec = out[i] as ChainRecord;
    const doc = JSON.parse(rec.canonical) as Record<string, unknown>;
    if (i === from) mutate(doc);
    rec.canonical = canonicalize(doc);
    rec.prev_hash = prev;
    rec.record_hash = hashRecord(prev, rec.canonical);
    prev = rec.record_hash;
  }
  return out;
}

describe('canonical JSON', () => {
  it('sorts keys, drops whitespace and encodes the same value the same way', () => {
    expect(canonicalize({ b: 1, a: { d: [3, 2], c: 'x' } })).toBe('{"a":{"c":"x","d":[3,2]},"b":1}');
    expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }));
    expect(canonicalize('é "\n')).toBe(JSON.stringify('é "\n'));
    expect(canonicalize([null, true, false, 0, -7])).toBe('[null,true,false,0,-7]');
  });

  it('refuses everything outside the subset instead of guessing', () => {
    for (const bad of [
      1.5,
      Number.NaN,
      Infinity,
      2 ** 60,
      undefined,
      10n,
      () => 1,
      Symbol('x'),
      new Date(0),
      new Map(),
      { a: undefined },
    ]) {
      expect(() => canonicalize(bad), typeof bad).toThrow(TypeError);
    }
    let deep: unknown = 1;
    for (let i = 0; i < 40; i += 1) deep = [deep];
    expect(() => canonicalize(deep)).toThrow(/too deep/);
  });
});

describe('hashing', () => {
  it('the genesis constant is the SHA-256 of "prysm.demo.genesis.v1"', () => {
    expect(GENESIS_PREV_HASH).toBe(sha256Hex('prysm.demo.genesis.v1'));
    expect(GENESIS_PREV_HASH).toMatch(/^[0-9a-f]{64}$/);
  });

  it('record_hash is SHA-256 of prev_hash followed by the canonical JSON', () => {
    const r = buildRecord(0, GENESIS_PREV_HASH, { type: 't', actor: 'a', ts: '2026-10-28T10:00:00Z', data: { k: 1 } });
    expect(r.canonical).toBe('{"actor":"a","data":{"k":1},"seq":0,"ts":"2026-10-28T10:00:00Z","type":"t"}');
    expect(r.record_hash).toBe(sha256Hex(GENESIS_PREV_HASH + r.canonical));
    expect(r.prev_hash).toBe(GENESIS_PREV_HASH);
  });
});

describe('verifyChain', () => {
  it('accepts an intact chain, including an empty one', () => {
    const chain = makeChain(6);
    expect(verifyChain(chain)).toEqual({ ok: true, length: 6, head_hash: (chain[5] as ChainRecord).record_hash });
    expect(verifyChain([])).toEqual({ ok: true, length: 0, head_hash: GENESIS_PREV_HASH });
  });

  it('single-row tamper: editing one record fails at exactly that index', () => {
    for (const target of [0, 3, 5]) {
      const chain = makeChain(6);
      const doc = JSON.parse((chain[target] as ChainRecord).canonical) as Record<string, unknown>;
      doc['data'] = { ...(doc['data'] as object), decision: 'edited' };
      (chain[target] as ChainRecord).canonical = canonicalize(doc);
      expect(verifyChain(chain)).toMatchObject({ ok: false, index: target, reason: 'hash-mismatch' });
    }
  });

  it('a tampered hash alone is caught at the next record', () => {
    const chain = makeChain(6);
    (chain[2] as ChainRecord).record_hash = sha256Hex('forged');
    expect(verifyChain(chain)).toMatchObject({ ok: false, index: 2, reason: 'hash-mismatch' });
  });

  it('deleted row: a missing record is a gap at its index', () => {
    const chain = makeChain(6);
    chain.splice(3, 1);
    expect(verifyChain(chain)).toMatchObject({ ok: false, index: 3, reason: 'gap' });
  });

  it('deleted row with the later ones renumbered still fails (seq inside the hashed text)', () => {
    const chain = makeChain(6);
    chain.splice(3, 1);
    chain.forEach((r, i) => {
      r.seq = i;
    });
    const result = verifyChain(chain);
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ index: 3, reason: 'seq-mismatch' });
  });

  it('reordered rows are caught by position, whichever way they were swapped', () => {
    const swapped = makeChain(6);
    [swapped[1], swapped[2]] = [swapped[2] as ChainRecord, swapped[1] as ChainRecord];
    expect(verifyChain(swapped)).toMatchObject({ ok: false, index: 1 });

    const renumbered = makeChain(6);
    [renumbered[1], renumbered[2]] = [renumbered[2] as ChainRecord, renumbered[1] as ChainRecord];
    renumbered.forEach((r, i) => {
      r.seq = i;
    });
    expect(verifyChain(renumbered)).toMatchObject({ ok: false, index: 1, reason: 'seq-mismatch' });
  });

  it('a wrong prev_hash is reported as such', () => {
    const chain = makeChain(4);
    (chain[2] as ChainRecord).prev_hash = sha256Hex('elsewhere');
    expect(verifyChain(chain)).toMatchObject({ ok: false, index: 2, reason: 'wrong-prev' });
  });

  it('the first record must start from the genesis constant', () => {
    const chain = makeChain(3);
    (chain[0] as ChainRecord).prev_hash = sha256Hex('not genesis');
    expect(verifyChain(chain)).toMatchObject({ ok: false, index: 0, reason: 'wrong-prev' });
  });

  it('non-canonical text is refused even when its hash was recomputed', () => {
    const chain = makeChain(3);
    const spaced = JSON.stringify(JSON.parse((chain[1] as ChainRecord).canonical), null, 1);
    const rec = chain[1] as ChainRecord;
    rec.canonical = spaced;
    rec.record_hash = hashRecord(rec.prev_hash, spaced);
    expect(verifyChain(chain)).toMatchObject({ ok: false, index: 1, reason: 'bad-canonical' });
  });

  it('a queryable copy that differs from the hashed text is caught', () => {
    const chain = makeChain(3);
    const doc = JSON.parse((chain[1] as ChainRecord).canonical) as Record<string, unknown>;
    doc['actor'] = 'someone-else';
    (chain[1] as ChainRecord).payload = doc;
    expect(verifyChain(chain)).toMatchObject({ ok: false, index: 1, reason: 'payload-mismatch' });
    (chain[1] as ChainRecord).payload = JSON.parse((chain[1] as ChainRecord).canonical);
    expect(verifyChain(chain).ok).toBe(true);
  });
});

describe('the anchor (outside the database)', () => {
  it('full-chain rewrite: internally consistent, so only the anchor catches it', () => {
    const chain = makeChain(8);
    const anchor = anchorOf(chain);
    const rewritten = rewriteFrom(chain, 2, (doc) => {
      doc['data'] = { ...(doc['data'] as object), decision: 'allow', tampered_by: 'insider' };
    });
    expect(verifyChain(rewritten)).toMatchObject({ ok: true, length: 8 }); // nothing inside the chain gives it away
    expect(verifyChain(rewritten, anchor)).toMatchObject({ ok: false, reason: 'anchor-mismatch', index: 7 });
  });

  it('a rewrite that happens after the anchor length is not caught by it (the anchor only covers what it saw)', () => {
    const chain = makeChain(8);
    const anchor = anchorOf(chain.slice(0, 4));
    const rewritten = rewriteFrom(chain, 5, (doc) => {
      doc['actor'] = 'insider';
    });
    expect(verifyChain(rewritten, anchor).ok).toBe(true);
    expect(verifyChain(rewritten, anchorOf(chain)).ok).toBe(false);
  });

  it('truncation (cutting records off the end) leaves a valid chain that only the anchor catches', () => {
    const chain = makeChain(8);
    const anchor = anchorOf(chain);
    const cut = chain.slice(0, 5);
    expect(verifyChain(cut).ok).toBe(true);
    expect(verifyChain(cut, anchor)).toMatchObject({ ok: false, index: 5, reason: 'truncated' });
  });

  it('a chain that grew past the anchor still verifies against it', () => {
    const chain = makeChain(8);
    expect(verifyChain(chain, anchorOf(chain.slice(0, 5)))).toMatchObject({ ok: true, length: 8 });
    expect(verifyChain([], anchorOf([]))).toMatchObject({ ok: true });
  });
});

describe('anchor file', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  it('round-trips, reports a missing file as null, and rejects a malformed one', () => {
    dir = mkdtempSync(join(tmpdir(), 'anchor-'));
    const path = join(dir, 'nested', 'anchor.json');
    expect(readAnchor(path)).toBeNull();
    const anchor = anchorOf(makeChain(3));
    writeAnchor(path, anchor);
    expect(readAnchor(path)).toEqual(anchor);
    writeFileSync(path, '{"version":1,"length":-1,"head_hash":"x"}');
    expect(() => readAnchor(path)).toThrow();
  });

  it('only moves forward, and never re-anchors a rewritten or shortened chain', () => {
    dir = mkdtempSync(join(tmpdir(), 'anchor-'));
    const path = join(dir, 'anchor.json');
    const chain = makeChain(6);
    expect(advanceAnchor(path, chain.slice(0, 3))).toMatchObject({ advanced: true });
    expect(readAnchor(path)).toEqual(anchorOf(chain.slice(0, 3)));
    expect(advanceAnchor(path, chain)).toMatchObject({ advanced: true });
    expect(readAnchor(path)).toEqual(anchorOf(chain));
    expect(advanceAnchor(path, chain.slice(0, 4))).toMatchObject({ advanced: false, reason: 'shorter' });
    const rewritten = rewriteFrom(chain, 1, (doc) => {
      doc['actor'] = 'insider';
    });
    expect(advanceAnchor(path, rewritten)).toMatchObject({ advanced: false, reason: 'conflict' });
    expect(readAnchor(path)).toEqual(anchorOf(chain));
  });
});

describe('export pack', () => {
  it('verifies offline, with and without an anchor, and carries no database-only fields', () => {
    const chain = makeChain(5);
    const pack = exportPack(chain);
    expect(Object.keys(pack.records[0] ?? {}).sort()).toEqual(['canonical', 'prev_hash', 'record_hash', 'seq']);
    expect(verifyPack(pack)).toMatchObject({ ok: true, length: 5 });
    expect(verifyPack(pack, anchorOf(chain))).toMatchObject({ ok: true });
    expect(verifyPack(JSON.parse(JSON.stringify(pack)) as unknown)).toMatchObject({ ok: true });
  });

  it('catches tampering in the pack by index, and a rewritten pack only through the anchor', () => {
    const chain = makeChain(5);
    const pack = exportPack(chain);
    const edited = JSON.parse(JSON.stringify(pack)) as typeof pack;
    const target = edited.records[3] as { canonical: string };
    target.canonical = canonicalize({ ...(JSON.parse(target.canonical) as object), actor: 'someone-else' });
    expect(verifyPack(edited)).toMatchObject({ ok: false, index: 3, reason: 'hash-mismatch' });

    const rewritten = exportPack(
      rewriteFrom(chain, 1, (d) => {
        d['actor'] = 'insider';
      }),
    );
    expect(verifyPack(rewritten).ok).toBe(true);
    expect(verifyPack(rewritten, anchorOf(chain))).toMatchObject({ ok: false, reason: 'anchor-mismatch' });
  });

  it('rejects things that are not packs', () => {
    for (const bad of [
      null,
      {},
      { format: 'prysm-demo-evidence-pack', version: 1, genesis_prev_hash: 'abc', records: [] },
      'text',
    ]) {
      expect(verifyPack(bad)).toMatchObject({ ok: false, reason: 'bad-pack' });
    }
  });

  it('a pack written to disk reads back identical', () => {
    const d = mkdtempSync(join(tmpdir(), 'pack-'));
    try {
      const file = join(d, 'pack.json');
      const pack = exportPack(makeChain(2));
      writeFileSync(file, JSON.stringify(pack));
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(pack);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
