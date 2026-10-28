// DEMO-ONLY (TODO(T-001)). `pnpm demo:up`: start Postgres, create the demo database and roles, migrate, seed the
// first evidence record and check readiness. Safe to run again.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import {
  DEFAULT_ANCHOR_PATH,
  DEFAULT_POLICY_PATH,
  DEMO_ROOT,
  REPO_ROOT,
  composeFileArgs,
  demoDbUrls,
} from '../db/config.ts';
import { applyEvidenceMigration } from '../db/migrate.ts';
import { readAnchor } from '../evidence/anchor.ts';
import { parsePolicyYaml } from '../policy/index.ts';
import { appendEvidence, readChain, verifyAndAnchor } from '../evidence/store.ts';

const step = (msg: string): void => {
  process.stdout.write(`[demo:up] ${msg}\n`);
};
const compose = (args: string[], input?: string): string =>
  execFileSync('docker', ['compose', ...composeFileArgs(), ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    ...(input === undefined ? {} : { input }),
    stdio: ['pipe', 'pipe', 'inherit'],
  });

step('starting postgres (docker compose, waits until healthy)');
compose(['up', '-d', '--wait', 'postgres']);

step('creating the demo database and roles (idempotent)');
compose(
  ['exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q'],
  readFileSync(`${DEMO_ROOT}sql/000_provision.sql`, 'utf8'),
);

const urls = demoDbUrls();
step('migrating the evidence table (append-only grants and triggers)');
const owner = new pg.Client({ connectionString: urls.owner });
await owner.connect();
try {
  await applyEvidenceMigration(owner, 'prysm_demo_app');
} finally {
  await owner.end();
}

const app = new pg.Pool({ connectionString: urls.app, max: 2 });
try {
  if ((await readChain(app)).length === 0) {
    step('seeding the first evidence record (the policy that is loaded)');
    const policy = parsePolicyYaml(readFileSync(DEFAULT_POLICY_PATH, 'utf8'));
    await appendEvidence(app, {
      type: 'policy.loaded',
      actor: 'demo:up',
      ts: new Date().toISOString(),
      data: { policy_hash: policy.hash, policy_name: policy.policy.name ?? '', rule_count: policy.policy.rules.length },
    });
  }
  const { verify, anchor } = await verifyAndAnchor(app, DEFAULT_ANCHOR_PATH, readAnchor(DEFAULT_ANCHOR_PATH));
  if (!verify.ok) {
    process.stdout.write(
      `[demo:up] NOT READY: the stored chain fails verification at index ${String(verify.index)} (${verify.reason}). Reset it from the dashboard, or truncate the table as the owner.\n`,
    );
    process.exit(1);
  }
  step(
    `ready: ${String(verify.length)} evidence records, chain verified, anchor ${anchor?.advanced ? 'in place' : 'NOT advanced'}`,
  );
  step('next: pnpm demo:serve   (then open http://127.0.0.1:4300)  and  pnpm demo:agent');
} finally {
  await app.end();
}
