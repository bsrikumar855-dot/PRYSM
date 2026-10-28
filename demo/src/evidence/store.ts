import type pg from 'pg';
import { advanceAnchor, type AdvanceResult } from './anchor.ts';
import {
  GENESIS_PREV_HASH,
  anchorOf,
  buildRecord,
  hashRecord,
  verifyChain,
  type Anchor,
  type ChainRecord,
  type EvidenceInput,
  type VerifyResult,
} from './chain.ts';
import { canonicalize } from './canonical.ts';

// DEMO-ONLY (TODO(T-001), TODO(T-002)): talks to the demo's own table with pg directly.

/** Arbitrary constant key for the advisory lock that serialises appends. */
const APPEND_LOCK_KEY = 7_201_028;

/**
 * Appends one record. Appends are serialised with a transaction-level advisory lock, so two writers can never read
 * the same head and fork the chain; UNIQUE(seq) and UNIQUE(prev_hash) are the backstop if that ever failed.
 */
export async function appendEvidence(pool: pg.Pool, input: EvidenceInput): Promise<ChainRecord> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [APPEND_LOCK_KEY]);
    const head = await client.query<{ seq: string; record_hash: string }>(
      'SELECT seq, record_hash FROM evidence_log ORDER BY seq DESC LIMIT 1',
    );
    const row = head.rows[0];
    const record = buildRecord(row ? Number(row.seq) + 1 : 0, row ? row.record_hash : GENESIS_PREV_HASH, input);
    await client.query(
      'INSERT INTO evidence_log (seq, prev_hash, record_hash, canonical, payload) VALUES ($1, $2, $3, $4, $5)',
      [
        record.seq,
        record.prev_hash,
        record.record_hash,
        record.canonical,
        record.canonical, // jsonb parses the text; verification compares it back to the canonical text
      ],
    );
    await client.query('COMMIT');
    return record;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Every record in order, with the jsonb copy, as stored. */
export async function readChain(db: pg.Pool | pg.ClientBase): Promise<ChainRecord[]> {
  const { rows } = await db.query<{
    seq: string;
    prev_hash: string;
    record_hash: string;
    canonical: string;
    payload: unknown;
  }>('SELECT seq, prev_hash, record_hash, canonical, payload FROM evidence_log ORDER BY seq');
  return rows.map((r) => ({
    seq: Number(r.seq),
    prev_hash: r.prev_hash,
    record_hash: r.record_hash,
    canonical: r.canonical,
    payload: r.payload,
  }));
}

/** Reads the stored chain and verifies it, including the jsonb copies, against an optional anchor. */
export async function verifyStored(db: pg.Pool | pg.ClientBase, anchor?: Anchor): Promise<VerifyResult> {
  return verifyChain(await readChain(db), anchor);
}

/** Verifies, and only if the chain is intact moves the anchor file forward. Returns both outcomes. */
export async function verifyAndAnchor(
  db: pg.Pool | pg.ClientBase,
  anchorPath: string,
  anchor: Anchor | null,
): Promise<{ verify: VerifyResult; anchor: AdvanceResult | null }> {
  const records = await readChain(db);
  const verify = verifyChain(records, anchor ?? undefined);
  if (!verify.ok) return { verify, anchor: null };
  return { verify, anchor: advanceAnchor(anchorPath, records) };
}

// ---- DEMO-ONLY tampering, over a SEPARATE connection that uses the table OWNER role ----------------------------
// The app role cannot do any of this. The owner can switch the triggers off, which is exactly what an insider with
// admin rights could do, so the demo shows what the hash chain and the external anchor each catch.

async function asAdmin<T>(admin: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    await client.query('ALTER TABLE evidence_log DISABLE TRIGGER evidence_log_immutable');
    await client.query('ALTER TABLE evidence_log DISABLE TRIGGER evidence_log_no_truncate');
    const out = await fn(client);
    await client.query('ALTER TABLE evidence_log ENABLE TRIGGER evidence_log_immutable');
    await client.query('ALTER TABLE evidence_log ENABLE TRIGGER evidence_log_no_truncate');
    await client.query('COMMIT');
    return out;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

type Doc = { seq: number; type: string; actor: string; ts: string; data: Record<string, unknown> };

/** DEMO-ONLY. Edits one record's contents in place (flips a deny to an allow) and leaves every hash alone. */
export async function demoTamperEdit(admin: pg.Pool, seq: number): Promise<void> {
  await asAdmin(admin, async (c) => {
    const { rows } = await c.query<{ canonical: string }>('SELECT canonical FROM evidence_log WHERE seq = $1', [seq]);
    if (!rows[0]) throw new Error(`no record ${String(seq)}`);
    const doc = JSON.parse(rows[0].canonical) as Doc;
    doc.data = { ...doc.data, decision: 'allow', tampered_by: 'demo-admin' };
    const canonical = canonicalize(doc);
    await c.query('UPDATE evidence_log SET canonical = $2, payload = $3::jsonb WHERE seq = $1', [
      seq,
      canonical,
      canonical,
    ]);
  });
}

/**
 * DEMO-ONLY. The full rewrite: edits one record and then recomputes every hash from there to the head, so the
 * chain is internally consistent again. Only the anchor outside the database can tell.
 */
export async function demoFullRewrite(admin: pg.Pool, seq: number): Promise<void> {
  await asAdmin(admin, async (c) => {
    const { rows } = await c.query<{ seq: string; canonical: string }>(
      'SELECT seq, canonical FROM evidence_log ORDER BY seq',
    );
    let prev = GENESIS_PREV_HASH;
    for (const row of rows) {
      let canonical = row.canonical;
      if (Number(row.seq) === seq) {
        const doc = JSON.parse(canonical) as Doc;
        doc.data = { ...doc.data, decision: 'allow', tampered_by: 'demo-admin' };
        canonical = canonicalize(doc);
      }
      const recordHash = hashRecord(prev, canonical);
      await c.query(
        'UPDATE evidence_log SET prev_hash = $2, record_hash = $3, canonical = $4, payload = $5::jsonb WHERE seq = $1',
        [Number(row.seq), prev, recordHash, canonical, canonical],
      );
      prev = recordHash;
    }
  });
}

/** DEMO-ONLY. Removes a record outright (the later records keep their numbers, so a gap shows). */
export async function demoDeleteRow(admin: pg.Pool, seq: number): Promise<void> {
  await asAdmin(admin, async (c) => {
    await c.query('DELETE FROM evidence_log WHERE seq = $1', [seq]);
  });
}

/** DEMO-ONLY. Empties the table so the demo can start again. The caller must also delete the anchor file. */
export async function demoReset(admin: pg.Pool): Promise<void> {
  await asAdmin(admin, async (c) => {
    await c.query('TRUNCATE evidence_log');
  });
}

export { anchorOf };
