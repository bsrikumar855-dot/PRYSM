-- Baseline (ADR-0003, ADR-0007). Runs as prysm_owner, the owner of the database and of the public schema.
-- Runtime roles (prysm_app, prysm_platform, prysm_gateway_outbox) are provisioned by infrastructure beforehand.
-- Nobody but the owner may create objects in public; runtime roles get USAGE only, and each table
-- grants its privileges explicitly (no default privileges), so a new table is inaccessible until reviewed.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO prysm_app, prysm_platform, prysm_gateway_outbox;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS vector;
