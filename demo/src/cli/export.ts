// DEMO-ONLY (TODO(T-001)). Writes the evidence pack and a copy of the anchor to demo/.out/ so they can be verified
// offline with `pnpm demo:verify -- --pack demo/.out/evidence-pack.json --anchor demo/.out/anchor.json`.
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import pg from 'pg';
import { DEFAULT_ANCHOR_PATH, OUT_DIR, demoDbUrls } from '../db/config.ts';
import { exportPack } from '../evidence/pack.ts';
import { readChain } from '../evidence/store.ts';

const pool = new pg.Pool({ connectionString: demoDbUrls().app, max: 1 });
try {
  const records = await readChain(pool);
  mkdirSync(OUT_DIR, { recursive: true });
  const packPath = `${OUT_DIR}/evidence-pack.json`;
  writeFileSync(packPath, `${JSON.stringify(exportPack(records), null, 2)}\n`, 'utf8');
  process.stdout.write(`wrote ${packPath} (${String(records.length)} records)\n`);
  if (existsSync(DEFAULT_ANCHOR_PATH)) {
    copyFileSync(DEFAULT_ANCHOR_PATH, `${OUT_DIR}/anchor.json`);
    process.stdout.write(`wrote ${OUT_DIR}/anchor.json\n`);
  } else {
    process.stdout.write('no anchor file yet; the pack can be verified but a full rewrite would not be detected\n');
  }
} finally {
  await pool.end();
}
