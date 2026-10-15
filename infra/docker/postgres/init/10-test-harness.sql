-- DEV AND CI ONLY. Never run against a self-hosted or production database (TRACKING F-22, F-43).
-- Creates what the integration-test harness needs: a CREATEDB role and a migrated template database.
-- Idempotent, so CI and developers with an existing volume can run it again:
--   docker exec -i <postgres container> psql -v ON_ERROR_STOP=1 -U postgres < infra/docker/postgres/init/10-test-harness.sql
-- prysm_test_admin: no superuser, no RLS bypass, no replication, no role creation, and it is not
-- a member of any role. It can only create and drop databases cloned from prysm_template.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'prysm_test_admin') THEN
    CREATE ROLE prysm_test_admin LOGIN PASSWORD 'prysm-test-admin-dev-only'
      NOSUPERUSER NOBYPASSRLS NOREPLICATION CREATEDB NOCREATEROLE;
  END IF;
END
$$;

-- The template is owned by prysm_owner and flagged IS_TEMPLATE, so any CREATEDB role may clone it.
-- `pnpm db:template` applies the migrations to it.
SELECT 'CREATE DATABASE prysm_template OWNER prysm_owner IS_TEMPLATE true'
 WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'prysm_template')
\gexec

\connect prysm_template
CREATE EXTENSION IF NOT EXISTS vector;
-- In PG 15+ `public` is owned by pg_database_owner, which in a clone would be the cloning role.
-- Pin it to prysm_owner so a clone's schema owner stays prysm_owner (baseline test enforces it).
ALTER SCHEMA public OWNER TO prysm_owner;
