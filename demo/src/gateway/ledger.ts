import type pg from 'pg';
import { advanceAnchor, readAnchor } from '../evidence/anchor.ts';
import type { ChainRecord, VerifyResult } from '../evidence/chain.ts';
import { appendEvidence, readChain } from '../evidence/store.ts';
import { verifyChain } from '../evidence/chain.ts';
import type { EventHub } from './events.ts';

// DEMO-ONLY (TODO(T-001)). The one place the gateway writes evidence. Each record is appended (serialised in the
// database), pushed to the dashboard, and then the chain is verified and, only if it is intact, the external anchor
// is moved forward. Writes are queued in-process so the anchor file never races itself.

export interface RecordView {
  seq: number;
  ts: string;
  type: string;
  actor: string;
  data: Record<string, unknown>;
  record_hash: string;
}

export type VerifyState = {
  result: VerifyResult;
  anchor: { present: boolean; length: number | null; head_hash: string | null };
};

/** Decodes a stored record for display. The canonical text is trusted only as far as verification says so. */
export function viewOf(record: ChainRecord): RecordView {
  const doc = JSON.parse(record.canonical) as {
    seq: number;
    ts: string;
    type: string;
    actor: string;
    data: Record<string, unknown>;
  };
  return {
    seq: doc.seq,
    ts: doc.ts,
    type: doc.type,
    actor: doc.actor,
    data: doc.data,
    record_hash: record.record_hash,
  };
}

export class Ledger {
  readonly #db: pg.Pool;
  readonly #anchorPath: string;
  readonly #hub: EventHub;
  readonly #clock: () => Date;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(db: pg.Pool, anchorPath: string, hub: EventHub, clock: () => Date) {
    this.#db = db;
    this.#anchorPath = anchorPath;
    this.#hub = hub;
    this.#clock = clock;
  }

  /** Appends one record, publishes it, then verifies and (if intact) advances the anchor. Returns the record's view. */
  record(type: string, actor: string, data: Record<string, unknown>): Promise<RecordView> {
    const run = async (): Promise<RecordView> => {
      const stored = await appendEvidence(this.#db, { type, actor, data, ts: this.#clock().toISOString() });
      const view = viewOf(stored);
      this.#hub.publish('record', view);
      await this.refresh();
      return view;
    };
    const next = this.#queue.then(run, run);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  /** Verifies the stored chain against the anchor, advances the anchor if the chain is intact, and publishes the state. */
  async refresh(): Promise<VerifyState> {
    const records = await readChain(this.#db);
    const anchor = readAnchor(this.#anchorPath);
    const result = verifyChain(records, anchor ?? undefined);
    if (result.ok) advanceAnchor(this.#anchorPath, records);
    const current = readAnchor(this.#anchorPath);
    const state: VerifyState = {
      result,
      anchor: { present: current !== null, length: current?.length ?? null, head_hash: current?.head_hash ?? null },
    };
    this.#hub.publish('verify', state);
    return state;
  }

  async recent(limit: number): Promise<RecordView[]> {
    const records = await readChain(this.#db);
    return records.slice(-limit).map((r) => {
      try {
        return viewOf(r);
      } catch {
        // A row whose text is no longer even JSON is shown as damaged rather than hidden.
        return { seq: r.seq, ts: '', type: 'unreadable', actor: '', data: {}, record_hash: r.record_hash };
      }
    });
  }

  /** Waits for queued writes (used by tests and shutdown). */
  async idle(): Promise<void> {
    await this.#queue;
  }
}
