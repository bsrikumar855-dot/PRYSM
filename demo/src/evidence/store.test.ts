import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@prysm/db/testing';
import { applyEvidenceMigration } from '../db/migrate.ts';
import { readAnchor } from './anchor.ts';
import { anchorOf } from './chain.ts';
import {
  appendEvidence,
  demoDeleteRow,
  demoFullRewrite,
  demoReset,
  demoTamperEdit,
  readChain,
  verifyAndAnchor,
  verifyStored,
} from './store.ts';

// Runs against a throwaway clone database. In it the table owner is prysm_owner and the "app" role is prysm_app,
// the same two roles the demo uses under different names (prysm_demo_owner / prysm_demo_app).
let testDb: TestDatabase;
let app: pg.Pool;
let owner: pg.Pool;
let dir = '';

const event = (i: number) => ({
  type: 'tool_call.decision',
  actor: 'gateway',
  ts: `2026-10-28T10:00:${String(i % 60).padStart(2, '0')}Z`,
  data: { decision: 'deny', tool: `tool_${String(i)}`, n: i },
});

async function seed(n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) await appendEvidence(app, event(i));
}

beforeAll(async () => {
  testDb = await createTestDatabase({ suite: 'demo_evidence' });
  owner = new pg.Pool({ connectionString: testDb.ownerUrl, max: 3 });
  app = new pg.Pool({ connectionString: testDb.appUrl, max: 12 });
  const client = await owner.connect();
  try {
    await applyEvidenceMigration(client, 'prysm_app');
    await applyEvidenceMigration(client, 'prysm_app'); // idempotent
  } finally {
    client.release();
  }
  dir = mkdtempSync(join(tmpdir(), 'demo-evidence-'));
});

afterAll(async () => {
  await Promise.all([app.end(), owner.end()]);
  await testDb.drop();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await demoReset(owner);
});

describe('append and verify', () => {
  it('appends in order and the stored chain verifies, jsonb copy included', async () => {
    await seed(5);
    const chain = await readChain(app);
    expect(chain.map((r) => r.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(await verifyStored(app)).toMatchObject({ ok: true, length: 5 });
  });

  it('parallel appends never fork the chain: 60 concurrent writers give seq 0..59 with every link intact', async () => {
    await Promise.all(Array.from({ length: 60 }, (_, i) => appendEvidence(app, event(i))));
    const chain = await readChain(app);
    expect(chain.map((r) => r.seq)).toEqual(Array.from({ length: 60 }, (_, i) => i));
    expect(new Set(chain.map((r) => r.prev_hash)).size).toBe(60);
    expect(await verifyStored(app)).toMatchObject({ ok: true, length: 60 });
  });

  it('the database itself refuses a duplicate sequence number or a forked prev_hash', async () => {
    await seed(2);
    const first = (await readChain(app))[0];
    await expect(
      app.query(
        'INSERT INTO evidence_log (seq, prev_hash, record_hash, canonical, payload) VALUES (1, $1, $2, $3, $4)',
        [first?.prev_hash, 'a'.repeat(64), '{}', '{}'],
      ),
    ).rejects.toThrow(/duplicate key/);
  });
});

describe('the app role cannot change history', () => {
  beforeEach(async () => {
    await seed(3);
  });

  const attempts: [string, string][] = [
    ['UPDATE a row', "UPDATE evidence_log SET canonical = '{}' WHERE seq = 1"],
    ['DELETE a row', 'DELETE FROM evidence_log WHERE seq = 1'],
    ['TRUNCATE the table', 'TRUNCATE evidence_log'],
    ['disable the immutability trigger', 'ALTER TABLE evidence_log DISABLE TRIGGER evidence_log_immutable'],
    ['drop the trigger', 'DROP TRIGGER evidence_log_immutable ON evidence_log'],
    ['drop the table', 'DROP TABLE evidence_log'],
    ['become the owner', 'SET ROLE prysm_owner'],
  ];
  for (const [what, sql] of attempts) {
    it(`cannot ${what}`, async () => {
      await expect(app.query(sql)).rejects.toThrow(/permission denied|append-only|must be owner|must be member/i);
      expect(await verifyStored(app)).toMatchObject({ ok: true, length: 3 });
    });
  }

  it('GRANT is a no-op and UPDATE stays denied at the privilege level', async () => {
    await app.query('GRANT UPDATE ON evidence_log TO prysm_app').catch(() => undefined);
    const { rows } = await owner.query<{ u: boolean; d: boolean; i: boolean; s: boolean }>(
      `SELECT has_table_privilege('prysm_app','evidence_log','UPDATE') AS u, has_table_privilege('prysm_app','evidence_log','DELETE') AS d,
              has_table_privilege('prysm_app','evidence_log','INSERT') AS i, has_table_privilege('prysm_app','evidence_log','SELECT') AS s`,
    );
    expect(rows[0]).toEqual({ u: false, d: false, i: true, s: true });
  });

  it('even the table owner is stopped by the trigger while it is enabled', async () => {
    await expect(owner.query("UPDATE evidence_log SET canonical = '{}' WHERE seq = 1")).rejects.toThrow(/append-only/);
    await expect(owner.query('DELETE FROM evidence_log WHERE seq = 1')).rejects.toThrow(/append-only/);
    await expect(owner.query('TRUNCATE evidence_log')).rejects.toThrow(/append-only/);
  });
});

describe('tampering by someone with admin rights (the demo admin connection)', () => {
  beforeEach(async () => {
    await seed(6);
  });

  it('editing one row is caught at that index, and the triggers are back on afterwards', async () => {
    await demoTamperEdit(owner, 3);
    expect(await verifyStored(app)).toMatchObject({ ok: false, index: 3, reason: 'hash-mismatch' });
    await expect(owner.query("UPDATE evidence_log SET canonical = '{}' WHERE seq = 1")).rejects.toThrow(/append-only/);
  });

  it('deleting a row is caught as a gap at its index', async () => {
    await demoDeleteRow(owner, 2);
    expect(await verifyStored(app)).toMatchObject({ ok: false, index: 2, reason: 'gap' });
  });

  it('reordering two rows is caught', async () => {
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE evidence_log DISABLE TRIGGER evidence_log_immutable');
      // Swap the two rows' positions by swapping their sequence numbers; each row keeps its own contents and hashes.
      await client.query('UPDATE evidence_log SET seq = 100 WHERE seq = 1');
      await client.query('UPDATE evidence_log SET seq = 1 WHERE seq = 2');
      await client.query('UPDATE evidence_log SET seq = 2 WHERE seq = 100');
      await client.query('ALTER TABLE evidence_log ENABLE TRIGGER evidence_log_immutable');
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const result = await verifyStored(app);
    expect(result).toMatchObject({ ok: false, index: 1 });
  });

  it('editing only the jsonb copy is caught as a payload mismatch', async () => {
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE evidence_log DISABLE TRIGGER evidence_log_immutable');
      await client.query(
        `UPDATE evidence_log SET payload = jsonb_set(payload, '{actor}', '"someone-else"') WHERE seq = 4`,
      );
      await client.query('ALTER TABLE evidence_log ENABLE TRIGGER evidence_log_immutable');
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    expect(await verifyStored(app)).toMatchObject({ ok: false, index: 4, reason: 'payload-mismatch' });
  });

  it('a full-chain rewrite verifies on its own and is caught only by the anchor', async () => {
    const anchorPath = join(dir, 'rewrite', 'anchor.json');
    const before = await verifyAndAnchor(app, anchorPath, readAnchor(anchorPath));
    expect(before.verify.ok).toBe(true);
    const anchor = readAnchor(anchorPath);
    expect(anchor).toEqual(anchorOf(await readChain(app)));

    await demoFullRewrite(owner, 2);
    expect(await verifyStored(app)).toMatchObject({ ok: true, length: 6 }); // no inside signal at all
    expect(await verifyStored(app, anchor ?? undefined)).toMatchObject({ ok: false, reason: 'anchor-mismatch' });

    const after = await verifyAndAnchor(app, anchorPath, anchor);
    expect(after.verify).toMatchObject({ ok: false, reason: 'anchor-mismatch' });
    expect(readAnchor(anchorPath)).toEqual(anchor); // the rewritten chain did not get to move the anchor
  });

  it('cutting records off the end is caught only by the anchor', async () => {
    const anchorPath = join(dir, 'cut', 'anchor.json');
    await verifyAndAnchor(app, anchorPath, null);
    const anchor = readAnchor(anchorPath);
    await demoDeleteRow(owner, 5);
    expect(await verifyStored(app)).toMatchObject({ ok: true, length: 5 });
    expect(await verifyStored(app, anchor ?? undefined)).toMatchObject({ ok: false, reason: 'truncated', index: 5 });
  });

  it('appending after an anchored chain keeps verifying and moves the anchor forward', async () => {
    const anchorPath = join(dir, 'grow', 'anchor.json');
    await verifyAndAnchor(app, anchorPath, null);
    await seed(2);
    const out = await verifyAndAnchor(app, anchorPath, readAnchor(anchorPath));
    expect(out.verify).toMatchObject({ ok: true, length: 8 });
    expect(readAnchor(anchorPath)).toMatchObject({ length: 8 });
  });
});
