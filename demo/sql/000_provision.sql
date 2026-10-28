-- DEMO-ONLY (TODO(T-001)). Run once as the Postgres superuser by `pnpm demo:up`. Idempotent. Credentials are
-- throwaway, labelled dev-only, and bound to a loopback-only dev database; they protect nothing real.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'prysm_demo_owner') THEN
    CREATE ROLE prysm_demo_owner LOGIN PASSWORD 'prysm-demo-owner-dev-only' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'prysm_demo_app') THEN
    CREATE ROLE prysm_demo_app LOGIN PASSWORD 'prysm-demo-app-dev-only' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END
$$;

SELECT 'CREATE DATABASE prysm_demo OWNER prysm_demo_owner'
 WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'prysm_demo')
\gexec

\connect prysm_demo
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO prysm_demo_app;
ALTER SCHEMA public OWNER TO prysm_demo_owner;
