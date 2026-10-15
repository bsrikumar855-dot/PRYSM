import type { ClientBase, Pool } from 'pg';
import { GLOBAL_TABLES, TENANT_ROOT_TABLE } from './tables.ts';

export interface RlsGap {
  table: string;
  rlsEnabled: boolean;
  rlsForced: boolean;
  /** Policies of any kind on the table. */
  policies: number;
  /** Policies that apply to every command and have both USING and WITH CHECK. */
  completePolicies: number;
}

/**
 * Every tenant table (one with a `tenant_id` column, plus `tenants`, which is keyed by `id`) must have RLS
 * enabled *and* forced and at least one policy that covers all commands with both USING and WITH CHECK
 * (ADR-0007). Returns the tables that don't; an empty list means full coverage.
 */
export async function findRlsGaps(db: Pool | ClientBase): Promise<RlsGap[]> {
  const { rows } = await db.query<{
    table: string;
    rls_enabled: boolean;
    rls_forced: boolean;
    policies: string;
    complete: string;
  }>(
    `
    SELECT c.relname AS table,
           c.relrowsecurity AS rls_enabled,
           c.relforcerowsecurity AS rls_forced,
           (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies,
           (SELECT count(*) FROM pg_policy p
             WHERE p.polrelid = c.oid AND p.polcmd = '*' AND p.polqual IS NOT NULL AND p.polwithcheck IS NOT NULL) AS complete
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p')
       AND (c.relname = $1
            OR EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped))
     ORDER BY c.relname`,
    [TENANT_ROOT_TABLE],
  );
  return rows
    .map((r) => ({
      table: r.table,
      rlsEnabled: r.rls_enabled,
      rlsForced: r.rls_forced,
      policies: Number(r.policies),
      completePolicies: Number(r.complete),
    }))
    .filter((r) => !r.rlsEnabled || !r.rlsForced || r.completePolicies === 0);
}

export type TenancyProblemKind =
  | 'unlisted-global-table'
  | 'allowlist-entry-without-table'
  | 'allowlisted-table-has-tenant-id'
  | 'allowlist-entry-without-reason';

export interface TenancyProblem {
  table: string;
  problem: TenancyProblemKind;
}

/**
 * ADR-0013 allowlist check, both ways. Every `public` table is either tenant-scoped (has `tenant_id`, or is
 * `tenants`) or a global table on `allowlist`. Reports a global table that is not on the list, a list entry
 * with no table, a listed table that has a `tenant_id` column (it would need RLS), and an entry with no reason.
 */
export async function findTenancyProblems(
  db: Pool | ClientBase,
  allowlist: Readonly<Record<string, string>> = GLOBAL_TABLES,
): Promise<TenancyProblem[]> {
  const { rows } = await db.query<{ table: string; has_tenant_id: boolean }>(
    `
    SELECT c.relname AS table,
           EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped) AS has_tenant_id
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
     ORDER BY c.relname`,
  );
  const existing = new Map(rows.map((r) => [r.table, r.has_tenant_id]));
  const problems: TenancyProblem[] = [];
  for (const [table, hasTenantId] of existing) {
    if (table === TENANT_ROOT_TABLE) continue;
    const listed = Object.hasOwn(allowlist, table);
    if (!hasTenantId && !listed) problems.push({ table, problem: 'unlisted-global-table' });
    if (hasTenantId && listed) problems.push({ table, problem: 'allowlisted-table-has-tenant-id' });
  }
  for (const [table, reason] of Object.entries(allowlist)) {
    if (!existing.has(table)) problems.push({ table, problem: 'allowlist-entry-without-table' });
    if (reason.trim() === '') problems.push({ table, problem: 'allowlist-entry-without-reason' });
  }
  return problems.sort((a, b) => a.table.localeCompare(b.table) || a.problem.localeCompare(b.problem));
}
