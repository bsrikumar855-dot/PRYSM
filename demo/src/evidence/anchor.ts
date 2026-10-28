import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { GENESIS_PREV_HASH, type Anchor, type ChainRecord } from './chain.ts';

// DEMO-ONLY (TODO(T-001)). The anchor is a tiny file kept OUTSIDE the database. In the product it would go to
// storage the database operator cannot write (ADR-0006: an off-platform destination); here it is a local file, which
// shows the idea but protects nothing against someone who can write that file too.

export const anchorSchema = z.strictObject({
  version: z.literal(1),
  length: z.number().int().min(0),
  head_hash: z.string().regex(/^[0-9a-f]{64}$/),
});

export function readAnchor(path: string): Anchor | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return null;
    throw error;
  }
  return anchorSchema.parse(JSON.parse(text));
}

/** Writes the anchor atomically (temp file, then rename) so a reader never sees half of one. */
export function writeAnchor(path: string, anchor: Anchor): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  writeFileSync(temp, `${JSON.stringify(anchor, null, 2)}\n`, 'utf8');
  renameSync(temp, path);
}

export type AdvanceResult =
  { advanced: true; anchor: Anchor } | { advanced: false; reason: 'conflict' | 'shorter'; detail: string };

/**
 * Moves the anchor forward to the end of `records`, but only if `records` still contains the current anchored head
 * at the anchored position. A chain that was rewritten or cut short never gets to re-anchor itself, so the old
 * anchor keeps catching it. The caller must have verified the chain first.
 */
export function advanceAnchor(path: string, records: readonly ChainRecord[]): AdvanceResult {
  const current = readAnchor(path);
  const last = records[records.length - 1];
  const next: Anchor = { version: 1, length: records.length, head_hash: last ? last.record_hash : GENESIS_PREV_HASH };
  if (current) {
    if (records.length < current.length)
      return { advanced: false, reason: 'shorter', detail: 'the chain is shorter than the anchor' };
    const at = current.length === 0 ? GENESIS_PREV_HASH : (records[current.length - 1] as ChainRecord).record_hash;
    if (at !== current.head_hash)
      return { advanced: false, reason: 'conflict', detail: 'the chain does not contain the anchored head' };
    if (current.length === next.length) return { advanced: true, anchor: current };
  }
  writeAnchor(path, next);
  return { advanced: true, anchor: next };
}
