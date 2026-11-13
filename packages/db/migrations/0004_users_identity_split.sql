-- Hand-written, forward-only (ADR-0003, ADR-0013, TRACKING F-49). Runs as prysm_owner. Edits nothing in 0001-0003: it
-- revokes and re-grants, adds RLS to `users` and adds the policies. Expand/contract: a later change to a grant or
-- policy here is a new migration, never an edit of this file.
--
-- Before: prysm_app could read every `users` row, password salt and tag included, from inside withTenant, and could
-- write the password columns. After:
--   * `prysm_identity` (an infrastructure-provisioned login role: NOSUPERUSER NOBYPASSRLS, no tenant-table privilege,
--     see infra/docker/postgres/init/00-dev-roles.sql) is the only role that touches the password columns. withGlobal
--     connects as it. Migrations never create roles (F-43), so the role must exist before this runs.
--   * `prysm_app` keeps SELECT on four non-secret columns and nothing else on `users`, and RLS shows it only the
--     users who are members of the tenant the transaction is scoped to.
-- Column classes (the code list is USERS_COLUMN_CLASSES in packages/db/src/tables.ts; a test fails if they disagree):
--   safe   = id, email, email_verified_at, created_at
--   secret = password_algorithm, password_memory_kib, password_passes, password_parallelism, password_salt, password_tag,
--            failed_logins, locked_until, disabled_at, updated_at

-- 1. The identity role may use the schema, and holds nothing on any tenant table (stated, so a later grant is a diff).
GRANT USAGE ON SCHEMA public TO prysm_identity;
--> statement-breakpoint
REVOKE ALL ON public.tenants, public.tenant_settings, public.memberships FROM prysm_identity;
--> statement-breakpoint

-- 2. prysm_app loses every privilege on users (REVOKE ALL on the table also removes the column UPDATE grants from
-- 0002), then gets SELECT on the safe columns only. No INSERT, UPDATE or DELETE, and no password column.
REVOKE ALL ON public.users FROM prysm_app;
--> statement-breakpoint
GRANT SELECT (id, email, email_verified_at, created_at) ON public.users TO prysm_app;
--> statement-breakpoint

-- 3. prysm_identity gets what the identity layer needs: read, create and update users, never delete.
-- UPDATE is column-limited: never `id` or `created_at`.
REVOKE ALL ON public.users FROM prysm_identity;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.users TO prysm_identity;
--> statement-breakpoint
GRANT UPDATE (
  email, email_verified_at, password_algorithm, password_memory_kib, password_passes, password_parallelism,
  password_salt, password_tag, failed_logins, locked_until, disabled_at, updated_at
) ON public.users TO prysm_identity;
--> statement-breakpoint

-- 4. Row-level security on users, enabled and forced like every other table (the owner gets no exemption).
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.users FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- prysm_app: SELECT only, and only rows whose user has a membership in the current tenant. The subquery runs as
-- prysm_app, so memberships' own tenant policy applies to it too. With no tenant set, app_tenant_id() is NULL and no
-- row matches. There is no INSERT, UPDATE or DELETE policy for prysm_app, so those are denied even if a grant appeared.
CREATE POLICY users_member_select ON public.users
  FOR SELECT TO prysm_app
  USING (EXISTS (
    SELECT 1 FROM public.memberships m
     WHERE m.user_id = users.id AND m.tenant_id = (SELECT public.app_tenant_id())
  ));
--> statement-breakpoint

-- prysm_identity: every row, because login and signup run before any tenant is known (ADR-0012). The grants above
-- are the limit on what it can do; this policy only lets those grants reach the rows.
CREATE POLICY users_identity_all ON public.users
  FOR ALL TO prysm_identity
  USING (true)
  WITH CHECK (true);
