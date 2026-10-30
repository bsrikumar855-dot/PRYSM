// Drizzle table definitions. drizzle-kit drafts the table DDL from these; RLS policies, grants and
// functions are hand-written SQL migrations in the same ordered directory (ADR-0003, ADR-0007).
export { users } from './identity.ts';
export { memberships, tenantSettings, tenants } from './tenancy.ts';
