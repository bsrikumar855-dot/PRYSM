import { readFileSync } from 'node:fs';
import type pg from 'pg';
import { DEMO_ROOT } from './config.ts';

/** Applies sql/001_evidence.sql as the table owner, granting the app role SELECT and INSERT only. */
export async function applyEvidenceMigration(owner: pg.ClientBase, appRole: string): Promise<void> {
  if (!/^[a-z_][a-z0-9_]*$/.test(appRole)) throw new TypeError('appRole must be a plain lower-case identifier');
  const sql = readFileSync(`${DEMO_ROOT}sql/001_evidence.sql`, 'utf8').replaceAll('{{APP_ROLE}}', appRole);
  await owner.query(sql);
}
