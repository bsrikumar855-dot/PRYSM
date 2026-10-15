/** The tenant table with no `tenant_id` column: its RLS policy is on `id` (ADR-0013). */
export const TENANT_ROOT_TABLE = 'tenants';

/**
 * The reviewed allowlist of global identity tables (ADR-0013): tables outside tenant RLS that hold identity
 * and never tenant data. Each entry has a reason. A table lands here in the same commit as the migration that
 * creates it; the coverage check fails if a global table is missing from this list or an entry has no table.
 * ADR-0013 expects five by the end of M1; the list grows with each migration.
 */
export const GLOBAL_TABLES: Readonly<Record<string, string>> = {
  users:
    'One row per person, shared by every tenant they belong to; identity only, no tenant data (ADR-0012, ADR-0013).',
};

/**
 * Every tenant-scoped table, for code that must refuse to touch them (`withGlobal`). A test compares this to
 * the catalog, so it cannot drift from the migrations.
 */
export const TENANT_TABLES: readonly string[] = ['memberships', 'tenant_settings', 'tenants'];
