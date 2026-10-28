import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { createTestDatabase, type TestDatabase } from '@prysm/db/testing';
import { ReplayChatModel, loadFixtures, type ChatModel } from '../adapter/index.ts';
import { DEMO_TOOLS } from '../adapter/tools.ts';
import { applyEvidenceMigration } from '../db/migrate.ts';
import { demoReset } from '../evidence/store.ts';
import { ApprovalBroker } from '../gateway/approvals.ts';
import { EventHub } from '../gateway/events.ts';
import { Ledger } from '../gateway/ledger.ts';
import { createGatewayServer } from '../gateway/server.ts';
import { parsePolicyYaml } from '../policy/index.ts';

// Test support only: a real demo server on an ephemeral port over a throwaway database, using the shipped policy and
// the hand-written replay fixtures.
export interface TestServer {
  base: string;
  db: pg.Pool;
  admin: pg.Pool;
  ledger: Ledger;
  anchorPath: string;
  reset(): Promise<void>;
  stop(): Promise<void>;
}

export async function startTestServer(suite: string, model?: ChatModel): Promise<TestServer> {
  const root = new URL('../../', import.meta.url).pathname;
  const testDb: TestDatabase = await createTestDatabase({ suite });
  const admin = new pg.Pool({ connectionString: testDb.ownerUrl, max: 3 });
  const db = new pg.Pool({ connectionString: testDb.appUrl, max: 8 });
  const c = await admin.connect();
  try {
    await applyEvidenceMigration(c, 'prysm_app');
  } finally {
    c.release();
  }
  const dir = mkdtempSync(join(tmpdir(), 'demo-ts-'));
  const anchorPath = join(dir, 'anchor.json');
  const hub = new EventHub();
  const clock = (): Date => new Date();
  const ledger = new Ledger(db, anchorPath, hub, clock);
  let listening = 0;
  const made = createGatewayServer({
    model: model ?? new ReplayChatModel(loadFixtures(`${root}fixtures/replay.json`)),
    policy: parsePolicyYaml(readFileSync(`${root}policies/demo-policy.yaml`, 'utf8')),
    ledger,
    approvals: new ApprovalBroker(),
    hub,
    db,
    admin,
    anchorPath,
    webRoot: `${root}web`,
    mode: 'replay',
    port: () => listening,
    defaultTools: DEMO_TOOLS,
    approvalTimeoutMs: 10_000,
    clock,
  });
  const server: Server = made.server;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  listening = (server.address() as { port: number }).port;
  return {
    base: `http://127.0.0.1:${String(listening)}`,
    db,
    admin,
    ledger,
    anchorPath,
    reset: async () => {
      await ledger.idle();
      await demoReset(admin);
      rmSync(anchorPath, { force: true });
    },
    stop: async () => {
      await made.close();
      await Promise.all([db.end(), admin.end()]);
      await testDb.drop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
