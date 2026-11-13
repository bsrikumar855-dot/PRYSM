-- Hand-written, forward-only (ADR-0003). 0002 qualified every name inside app_tenant_id() with pg_catalog, but did
-- not pin the function's own search_path. Pin it, so a schema or temp object created later can never shadow a
-- name the helper resolves, whoever calls it. `pg_temp` is last on purpose: temp objects are searched last.
-- The helper stays STABLE and SECURITY INVOKER; the policies already call it as (SELECT public.app_tenant_id()).
ALTER FUNCTION public.app_tenant_id() SET search_path = pg_catalog, pg_temp;
