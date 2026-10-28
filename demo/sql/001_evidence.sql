-- DEMO-ONLY (TODO(T-001)). The demo's own evidence table. Run as the table OWNER; {{APP_ROLE}} is the role the
-- demo server uses at runtime. Idempotent, so `pnpm demo:up` can run it again.
--
-- Append-only, three ways: the app role is granted SELECT and INSERT only (no UPDATE, DELETE or TRUNCATE); a row
-- trigger raises on UPDATE and DELETE for every role; a statement trigger raises on TRUNCATE. The app role does
-- not own the table, so it cannot disable the triggers or change the grants. The owner can, which is what an
-- insider with admin rights could do, and why the chain is also anchored outside the database.

CREATE TABLE IF NOT EXISTS evidence_log (
  seq         bigint      PRIMARY KEY CHECK (seq >= 0),
  prev_hash   char(64)    NOT NULL CHECK (prev_hash ~ '^[0-9a-f]{64}$'),
  record_hash char(64)    NOT NULL CHECK (record_hash ~ '^[0-9a-f]{64}$'),
  canonical   text        NOT NULL,
  payload     jsonb       NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT evidence_log_record_hash_key UNIQUE (record_hash),
  CONSTRAINT evidence_log_prev_hash_key UNIQUE (prev_hash)
);

CREATE OR REPLACE FUNCTION evidence_log_refuse() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    RAISE EXCEPTION 'evidence_log is append-only: % is not allowed', TG_OP
      USING ERRCODE = 'integrity_constraint_violation';
  END
  $$;

DROP TRIGGER IF EXISTS evidence_log_immutable ON evidence_log;
CREATE TRIGGER evidence_log_immutable BEFORE UPDATE OR DELETE ON evidence_log
  FOR EACH ROW EXECUTE FUNCTION evidence_log_refuse();

DROP TRIGGER IF EXISTS evidence_log_no_truncate ON evidence_log;
CREATE TRIGGER evidence_log_no_truncate BEFORE TRUNCATE ON evidence_log
  FOR EACH STATEMENT EXECUTE FUNCTION evidence_log_refuse();

REVOKE ALL ON evidence_log FROM PUBLIC;
REVOKE ALL ON evidence_log FROM {{APP_ROLE}};
GRANT SELECT, INSERT ON evidence_log TO {{APP_ROLE}};
