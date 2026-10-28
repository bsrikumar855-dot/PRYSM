// DEMO-ONLY (TODO(T-001)). `pnpm demo:serve`: starts the demo server on 127.0.0.1:4300 (DEMO_PORT to change it).
//   DEMO_MODEL_MODE=replay  (default) answers from demo/fixtures/replay.json, no network, no key
//   DEMO_MODEL_MODE=live    calls the Meta Model API with META_MODEL_* from .env.demo
//   DEMO_MODEL_MODE=record  live, and also writes demo/.out/recorded.json for later replay
import { readFileSync } from 'node:fs';
import pg from 'pg';
import {
  MetaChatModel,
  RecordingChatModel,
  ReplayChatModel,
  loadFixtures,
  metaConfigFromEnv,
  type ChatModel,
} from '../adapter/index.ts';
import { DEMO_TOOLS } from '../adapter/tools.ts';
import { DEFAULT_ANCHOR_PATH, DEFAULT_POLICY_PATH, DEMO_ROOT, OUT_DIR, demoDbUrls } from '../db/config.ts';
import { parsePolicyYaml } from '../policy/index.ts';
import { ApprovalBroker } from './approvals.ts';
import { EventHub } from './events.ts';
import { Ledger } from './ledger.ts';
import { createGatewayServer } from './server.ts';

const mode = process.env['DEMO_MODEL_MODE'] ?? 'replay';
const port = Number(process.env['DEMO_PORT'] ?? 4300);

let model: ChatModel;
if (mode === 'replay') {
  model = new ReplayChatModel(loadFixtures(process.env['DEMO_REPLAY_FIXTURES'] ?? `${DEMO_ROOT}fixtures/replay.json`));
} else if (mode === 'live' || mode === 'record') {
  const config = metaConfigFromEnv();
  if (!config) {
    process.stderr.write(
      'DEMO_MODEL_MODE=live needs META_MODEL_API_KEY in an untracked .env.demo. Use replay mode (the default) to run offline.\n',
    );
    process.exit(1);
  }
  const live = new MetaChatModel(config);
  model = mode === 'record' ? new RecordingChatModel(live, `${OUT_DIR}/recorded.json`) : live;
} else {
  process.stderr.write(`Unknown DEMO_MODEL_MODE "${mode}" (replay, live or record).\n`);
  process.exit(1);
}

const urls = demoDbUrls();
const db = new pg.Pool({ connectionString: urls.app, max: 8 });
// DEMO-ONLY: a second pool for the table-owner role, used only by the tamper and reset endpoints.
const admin = process.env['DEMO_DISABLE_TAMPER'] === '1' ? null : new pg.Pool({ connectionString: urls.owner, max: 2 });
const hub = new EventHub();
const clock = (): Date => new Date();
const ledger = new Ledger(db, DEFAULT_ANCHOR_PATH, hub, clock);
const policy = parsePolicyYaml(readFileSync(DEFAULT_POLICY_PATH, 'utf8'));

let listening = port;
const { server, close } = createGatewayServer({
  model,
  policy,
  ledger,
  approvals: new ApprovalBroker(),
  hub,
  db,
  admin,
  anchorPath: DEFAULT_ANCHOR_PATH,
  webRoot: `${DEMO_ROOT}web`,
  mode,
  port: () => listening,
  defaultTools: DEMO_TOOLS,
  approvalTimeoutMs: Number(process.env['DEMO_APPROVAL_TIMEOUT_MS'] ?? 5 * 60_000),
  clock,
});

server.listen(port, '127.0.0.1', () => {
  listening = (server.address() as { port: number }).port;
  process.stdout.write(
    `${JSON.stringify({ level: 'info', component: 'demo-gateway', event: 'listening', url: `http://127.0.0.1:${String(listening)}`, mode })}\n`,
  );
});

const shutdown = (): void => {
  void close().then(async () => {
    await Promise.all([db.end(), admin?.end()]);
    process.exit(0);
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
