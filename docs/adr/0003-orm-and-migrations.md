# ADR-0003: ORM and migrations

Status: Accepted · 2026-09-24

## Context
Tenant isolation relies on Postgres RLS with a per-transaction session variable (ADR-0007). The schema also needs things ORMs model badly: RLS policies, grants, immutability triggers, pgvector indexes, `tsvector` columns, partitioned event tables.

## Decision
- **Drizzle ORM** for the schema-as-code and the query builder in `packages/db`.
- Migrations are **SQL files**. `drizzle-kit generate` drafts the table DDL and a human reviews it. RLS policies, grants, triggers and partitioning are hand-written SQL migrations in the same ordered directory. Migrations are applied by `drizzle-kit migrate` running as `prysm_owner`.
- **Forward-only.** We get reversibility through expand/contract (add → backfill → switch → drop in a later release). A rollback is a new forward migration. Every PR that changes the schema includes a rollback note.
- The CI "migration check" job:
  1. applies all migrations to an empty DB, then to a snapshot of the previous release (Testcontainers)
  2. checks that `drizzle-kit generate` produces no diff
  3. runs the RLS coverage test (every table with `tenant_id` has `relrowsecurity` and `relforcerowsecurity` plus a policy)
  4. runs a lint for dangerous operations (non-concurrent index creation on large tables, `ALTER … TYPE`, etc.)
- All queries go through `withTenant(tenantId, fn)`. A raw pool isn't exported, and an ESLint rule bans importing it outside `packages/db`.
- The Python `ai-service` has no DB access, so Drizzle is the only schema owner.

## Consequences
- Drizzle's migration tooling is younger than Prisma's. We accept that, because the hand-written SQL path is first-class anyway.
- Transactions are explicit everywhere, which is also what RLS correctness needs.

## Alternatives
- **Prisma:** RLS session variables need a client extension that wraps each query in an interactive transaction, and there's a separate query-engine layer. We'd have less control over the SQL.
- **Kysely + a plain migration runner:** an excellent query builder, but no schema-as-code. It remains a good fallback if Drizzle gets in the way.
- **Raw SQL (postgres.js):** maximum control, but weaker typing across a big domain model.
