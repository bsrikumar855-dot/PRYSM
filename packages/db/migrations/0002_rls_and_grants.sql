-- Hand-written (ADR-0003, ADR-0007, ADR-0013). Runs as prysm_owner, forward-only: it adds a function,
-- policies and grants and removes nothing. Expand/contract: a later change to a policy or grant is a new
-- migration that drops and recreates it, never an edit of this file.

-- 1. The tenant the current transaction is scoped to, as a uuid, or NULL.
--
-- ADR-0007 sketches `current_setting('app.tenant_id', true)::uuid`. That form raises an error when the setting
-- is the empty string, and after any transaction that used set_config(..., true) a pooled connection reports
-- '' (not NULL) for the rest of its life, so the next query without a tenant would error instead of returning
-- no rows. This helper returns NULL for a missing, empty or malformed setting, so every policy below matches
-- no row (`tenant_id = NULL` is never true) and every insert fails its WITH CHECK. It is SECURITY INVOKER
-- on purpose: no RLS bypass anywhere (ADR-0012, ADR-0013).
CREATE FUNCTION public.app_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE SECURITY INVOKER
  AS $$
    SELECT CASE
      WHEN pg_catalog.current_setting('app.tenant_id', true)
           OPERATOR(pg_catalog.~*) '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN pg_catalog.current_setting('app.tenant_id', true)::uuid
    END
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.app_tenant_id() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.app_tenant_id() TO prysm_app;
--> statement-breakpoint

-- 2. Row-level security on every tenant table: enabled, forced (so the owner is subject to it too), and one
-- policy with both USING (what a statement can see or touch) and WITH CHECK (what it can write). `(SELECT ...)`
-- makes Postgres evaluate the helper once per statement instead of once per row.
ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.tenants FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.tenants
  FOR ALL
  USING (id = (SELECT public.app_tenant_id()))
  WITH CHECK (id = (SELECT public.app_tenant_id()));
--> statement-breakpoint
ALTER TABLE public.tenant_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.tenant_settings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.tenant_settings
  FOR ALL
  USING (tenant_id = (SELECT public.app_tenant_id()))
  WITH CHECK (tenant_id = (SELECT public.app_tenant_id()));
--> statement-breakpoint
ALTER TABLE public.memberships ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.memberships FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.memberships
  FOR ALL
  USING (tenant_id = (SELECT public.app_tenant_id()))
  WITH CHECK (tenant_id = (SELECT public.app_tenant_id()));
--> statement-breakpoint

-- 3. Grants. Nothing is granted by default (baseline migration), nothing to PUBLIC, nothing to
-- prysm_platform or prysm_gateway_outbox. prysm_app gets SELECT and INSERT, UPDATE on named columns only
-- (never a key or tenant_id column), and no DELETE, TRUNCATE, REFERENCES or TRIGGER.
REVOKE ALL ON public.tenants, public.tenant_settings, public.memberships, public.users FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.tenants TO prysm_app;
--> statement-breakpoint
GRANT UPDATE (name, status) ON public.tenants TO prysm_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.tenant_settings TO prysm_app;
--> statement-breakpoint
GRANT UPDATE (retention_mode, retention_days, sso_config_enc, updated_at) ON public.tenant_settings TO prysm_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.memberships TO prysm_app;
--> statement-breakpoint
GRANT UPDATE (role, status) ON public.memberships TO prysm_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.users TO prysm_app;
--> statement-breakpoint
GRANT UPDATE (
  email, email_verified_at, password_algorithm, password_memory_kib, password_passes, password_parallelism,
  password_salt, password_tag, failed_logins, locked_until, disabled_at, updated_at
) ON public.users TO prysm_app;
