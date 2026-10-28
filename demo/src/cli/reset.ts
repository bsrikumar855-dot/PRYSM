// DEMO-ONLY (TODO(T-001)). `pnpm demo:reset`: empties the evidence table (as the table owner, which can switch the
// append-only triggers off), deletes the anchor file and seeds the first record again. For starting the demo over after
// a tamper demonstration.
import { readFileSync, rmSync } from 'node:fs';
import pg from 'pg';
import { DEFAULT_ANCHOR_PATH, DEFAULT_POLICY_PATH, demoDbUrls } from '../db/config.ts';
import { demoReset, appendEvidence, readChain, verifyAndAnchor } from '../evidence/store.ts';
import { parsePolicyYaml } from '../policy/index.ts';

const urls = demoDbUrls();
const owner = new pg.Pool({ connectionString: urls.owner, max: 1 });
const app = new pg.Pool({ connectionString: urls.app, max: 1 });
try {
  await demoReset(owner);
  rmSync(DEFAULT_ANCHOR_PATH, { force: true });
  const policy = parsePolicyYaml(readFileSync(DEFAULT_POLICY_PATH, 'utf8'));
  await appendEvidence(app, {
    type: 'policy.loaded',
    actor: 'demo:reset',
    ts: new Date().toISOString(),
    data: { policy_hash: policy.hash, policy_name: policy.policy.name ?? '', rule_count: policy.policy.rules.length },
  });
  const { verify } = await verifyAndAnchor(app, DEFAULT_ANCHOR_PATH, null);
  process.stdout.write(
    verify.ok
      ? `reset: ${String((await readChain(app)).length)} record, chain verified, anchor in place\n`
      : 'reset failed verification\n',
  );
  process.exit(verify.ok ? 0 : 1);
} finally {
  await Promise.all([owner.end(), app.end()]);
}
