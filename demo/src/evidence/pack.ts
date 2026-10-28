import { z } from 'zod';
import { anchorSchema } from './anchor.ts';
import { GENESIS_PREV_HASH, verifyChain, type Anchor, type ChainRecord, type VerifyResult } from './chain.ts';

// DEMO-ONLY (TODO(T-001)). The export pack: everything an offline verifier needs, and nothing it has to trust.

export const PACK_FORMAT = 'prysm-demo-evidence-pack';

const recordSchema = z.strictObject({
  seq: z.number().int().min(0),
  prev_hash: z.string().regex(/^[0-9a-f]{64}$/),
  record_hash: z.string().regex(/^[0-9a-f]{64}$/),
  canonical: z.string(),
});

export const packSchema = z.strictObject({
  format: z.literal(PACK_FORMAT),
  version: z.literal(1),
  genesis_prev_hash: z.literal(GENESIS_PREV_HASH),
  records: z.array(recordSchema),
});
export type EvidencePack = z.infer<typeof packSchema>;

export function exportPack(records: readonly ChainRecord[]): EvidencePack {
  return {
    format: PACK_FORMAT,
    version: 1,
    genesis_prev_hash: GENESIS_PREV_HASH,
    records: records.map(({ seq, prev_hash, record_hash, canonical }) => ({ seq, prev_hash, record_hash, canonical })),
  };
}

export type PackVerifyResult = VerifyResult | { ok: false; index: -1; reason: 'bad-pack'; detail: string };

/** Verifies a pack (and optionally an anchor) with no database and no network. */
export function verifyPack(input: unknown, anchor?: Anchor): PackVerifyResult {
  const parsed = packSchema.safeParse(input);
  if (!parsed.success) return { ok: false, index: -1, reason: 'bad-pack', detail: z.prettifyError(parsed.error) };
  return verifyChain(parsed.data.records, anchor);
}

export function parseAnchor(input: unknown): Anchor {
  return anchorSchema.parse(input);
}
