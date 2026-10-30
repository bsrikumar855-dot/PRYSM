-- DEV AND CI ONLY (TRACKING F-43). Catch-up for a Postgres volume created before migration 0004: creates the
-- prysm_identity role that 0004 grants to. A fresh volume already has it from 00-dev-roles.sql, so this does nothing there.
-- Idempotent. On an existing volume, run it once before `pnpm db:migrate`:
--   docker exec -i <postgres container> psql -v ON_ERROR_STOP=1 -U postgres < infra/docker/postgres/init/05-identity-role.sql
-- Production roles and passwords are provisioned by infrastructure, never by migrations.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'prysm_identity') THEN
    CREATE ROLE prysm_identity LOGIN PASSWORD 'prysm-identity-dev-only'
      NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END
$$;
