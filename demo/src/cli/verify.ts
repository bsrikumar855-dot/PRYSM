// DEMO-ONLY (TODO(T-001)). Verifies an evidence pack offline (no database, no network), or the live table.
//   node src/cli/verify.ts --pack .out/evidence-pack.json [--anchor .anchor/anchor.json]
//   node src/cli/verify.ts                      (reads the demo database and the default anchor)
// Exit status 0 when the chain is intact (and matches the anchor), 1 when it is not, 2 for bad usage.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { readAnchor } from '../evidence/anchor.ts';
import { DEFAULT_ANCHOR_PATH } from '../db/config.ts';
import { parseAnchor, verifyPack } from '../evidence/pack.ts';
import type { PackVerifyResult } from '../evidence/pack.ts';

const { values } = parseArgs({
  options: { pack: { type: 'string' }, anchor: { type: 'string' }, json: { type: 'boolean', default: false } },
  strict: true,
});

function report(result: PackVerifyResult, anchored: boolean, source: string): never {
  if (values.json) {
    process.stdout.write(`${JSON.stringify({ source, anchored, ...result })}\n`);
  } else if (result.ok) {
    process.stdout.write(
      `OK   ${source}: ${String(result.length)} records, head ${result.head_hash.slice(0, 16)}..., ${anchored ? 'matches the anchor' : 'no anchor given (a full rewrite would not be detected)'}\n`,
    );
  } else {
    process.stdout.write(
      `FAIL ${source}: first bad record is index ${String(result.index)} (${result.reason}): ${result.detail}\n`,
    );
  }
  process.exit(result.ok ? 0 : 1);
}

if (values.pack) {
  const pack: unknown = JSON.parse(readFileSync(values.pack, 'utf8'));
  const anchor = values.anchor ? parseAnchor(JSON.parse(readFileSync(values.anchor, 'utf8'))) : undefined;
  report(verifyPack(pack, anchor), anchor !== undefined, values.pack);
} else {
  const [{ default: pg }, { demoDbUrls }, { readChain }, { verifyChain }] = await Promise.all([
    import('pg'),
    import('../db/config.ts'),
    import('../evidence/store.ts'),
    import('../evidence/chain.ts'),
  ]);
  const pool = new pg.Pool({ connectionString: demoDbUrls().app, max: 1 });
  try {
    const anchor = readAnchor(values.anchor ?? DEFAULT_ANCHOR_PATH) ?? undefined;
    report(verifyChain(await readChain(pool), anchor), anchor !== undefined, 'database');
  } finally {
    await pool.end();
  }
}
