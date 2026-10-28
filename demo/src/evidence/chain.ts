import { createHash } from 'node:crypto';
import { canonicalize } from './canonical.ts';

// DEMO-ONLY (TODO(T-001)). A hash chain over canonical-JSON records.
//
//   record_hash = SHA-256( prev_hash || canonical_json )
//
// where `||` is plain concatenation of the UTF-8 bytes of the 64-character lower-case hex prev_hash and the
// canonical JSON text. Because prev_hash has a fixed length, the join is unambiguous. The first record's prev_hash
// is the fixed genesis constant below. The sequence number lives inside the hashed document, so a record cannot be
// moved to another position without breaking its own hash.

/** SHA-256 of the ASCII string "prysm.demo.genesis.v1". Written out so a reader can check it by hand. */
export const GENESIS_PREV_HASH = '6663cf537b833d5fc97f3233c31e5c527ccc2fdfb0ae349976b55e79b448320c';

export interface EvidenceInput {
  /** What happened, e.g. "tool_call.decision". */
  type: string;
  /** Who or what did it, e.g. "gateway" or an approver label. */
  actor: string;
  /** Event details. Must already be free of raw PII and secrets. Canonical-JSON-able (safe integers only). */
  data: Record<string, unknown>;
  /** Event time, ISO 8601. Passed in so this module stays free of clocks. */
  ts: string;
}

export interface ChainRecord {
  seq: number;
  prev_hash: string;
  record_hash: string;
  /** The exact canonical JSON that was hashed. */
  canonical: string;
  /** Optional queryable copy (the database's jsonb column); when present it must equal the canonical document. */
  payload?: unknown;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** The hash of one record given the previous hash. */
export function hashRecord(prevHash: string, canonical: string): string {
  return sha256Hex(prevHash + canonical);
}

/** Builds the record at position `seq` after a record whose hash is `prevHash`. */
export function buildRecord(seq: number, prevHash: string, input: EvidenceInput): ChainRecord {
  const canonical = canonicalize({ seq, type: input.type, actor: input.actor, ts: input.ts, data: input.data });
  return { seq, prev_hash: prevHash, record_hash: hashRecord(prevHash, canonical), canonical };
}

/** A record's position in the chain, written outside the database so a rewrite of the whole chain is visible. */
export interface Anchor {
  version: 1;
  /** Number of records the chain had. */
  length: number;
  /** record_hash of the last of them, or the genesis constant when length is 0. */
  head_hash: string;
}

export function anchorOf(records: readonly ChainRecord[]): Anchor {
  const last = records[records.length - 1];
  return { version: 1, length: records.length, head_hash: last ? last.record_hash : GENESIS_PREV_HASH };
}

export type VerifyReason =
  | 'gap'
  | 'out-of-order'
  | 'seq-mismatch'
  | 'bad-canonical'
  | 'payload-mismatch'
  | 'wrong-prev'
  | 'hash-mismatch'
  | 'truncated'
  | 'anchor-mismatch';

export type VerifyResult =
  { ok: true; length: number; head_hash: string } | { ok: false; index: number; reason: VerifyReason; detail: string };

function fail(index: number, reason: VerifyReason, detail: string): VerifyResult {
  return { ok: false, index, reason, detail };
}

function sameDocument(payload: unknown, canonical: string): boolean {
  try {
    return canonicalize(payload) === canonical;
  } catch {
    return false;
  }
}

/**
 * Verifies the chain from the first record, returning the first bad index and why. With an anchor it also
 * checks that the chain still contains the anchored head at the anchored position, which is the only thing that
 * catches someone with write access who rewrote every hash consistently, or cut records off the end.
 */
export function verifyChain(records: readonly ChainRecord[], anchor?: Anchor): VerifyResult {
  let prev = GENESIS_PREV_HASH;
  for (let i = 0; i < records.length; i += 1) {
    const rec = records[i] as ChainRecord;
    if (rec.seq > i) return fail(i, 'gap', `expected seq ${String(i)}, found ${String(rec.seq)}: a record is missing`);
    if (rec.seq < i) return fail(i, 'out-of-order', `expected seq ${String(i)}, found ${String(rec.seq)}`);

    let parsed: unknown;
    try {
      parsed = JSON.parse(rec.canonical);
      if (canonicalize(parsed) !== rec.canonical) throw new Error('not canonical');
    } catch {
      return fail(i, 'bad-canonical', 'the stored text is not canonical JSON');
    }
    if ((parsed as { seq?: unknown }).seq !== i)
      return fail(i, 'seq-mismatch', 'the sequence number inside the record differs from its position');
    if (rec.payload !== undefined && !sameDocument(rec.payload, rec.canonical)) {
      return fail(i, 'payload-mismatch', 'the queryable copy of the record differs from the hashed text');
    }
    if (rec.prev_hash !== prev) return fail(i, 'wrong-prev', 'prev_hash does not match the previous record');
    if (hashRecord(rec.prev_hash, rec.canonical) !== rec.record_hash)
      return fail(i, 'hash-mismatch', 'record_hash does not match the record contents');
    prev = rec.record_hash;
  }

  if (anchor) {
    if (records.length < anchor.length) {
      return fail(
        records.length,
        'truncated',
        `the chain has ${String(records.length)} records but the anchor recorded ${String(anchor.length)}`,
      );
    }
    const anchored = anchor.length === 0 ? GENESIS_PREV_HASH : (records[anchor.length - 1] as ChainRecord).record_hash;
    if (anchored !== anchor.head_hash) {
      return fail(
        Math.max(anchor.length - 1, 0),
        'anchor-mismatch',
        'the chain no longer contains the anchored head: it was rewritten',
      );
    }
  }
  return { ok: true, length: records.length, head_hash: prev };
}
