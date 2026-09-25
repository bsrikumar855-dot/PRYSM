import type { ClientBase, Pool } from 'pg';

export interface RlsGap {
  table: string;
  rlsEnabled: boolean;
  rlsForced: boolean;
  policies: number;
}

/**
 * Every table in `public` with a `tenant_id` column must have RLS enabled *and* forced and at
 * least one policy (ADR-0007). Returns the tables that don't; an empty list means full coverage.
 */
export async function findRlsGaps(db: Pool | ClientBase): Promise<RlsGap[]> {
  const { rows } = await db.query<{ table: string; rls_enabled: boolean; rls_forced: boolean; policies: string }>(`
    SELECT c.relname AS table,
           c.relrowsecurity AS rls_enabled,
           c.relforcerowsecurity AS rls_forced,
           (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p')
       AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
     ORDER BY c.relname`);
  return rows
    .map((r) => ({ table: r.table, rlsEnabled: r.rls_enabled, rlsForced: r.rls_forced, policies: Number(r.policies) }))
    .filter((r) => !r.rlsEnabled || !r.rlsForced || r.policies === 0);
}
