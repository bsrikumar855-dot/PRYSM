# ADR-0007: Multi-tenancy strategy

Status: Accepted · 2026-09-24

## Context

Tenant isolation is absolute (principle 4). We need SaaS density, data residency, and a single-tenant self-hosted edition from the same code.

## Decision

- **Shared database, shared schema, `tenant_id` on every tenant-scoped table**, enforced by **Postgres RLS** _and_ the application layer.
- Roles:
  - `prysm_owner`: owns the tables and runs migrations. Never used at runtime.
  - `prysm_app`: runtime role for api, gateway and workers. Not the owner, `NOBYPASSRLS`. `FORCE ROW LEVEL SECURITY` on every tenant table.
  - `prysm_platform`: a narrow role for cross-tenant platform jobs (anchoring schedule, retention, metering rollups). It's used only from dedicated worker modules, and every use writes to the PRYSM admin AuditLog.
- Policy pattern (per table):
  ```sql
  CREATE POLICY tenant_isolation ON <t>
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
  ```
  An unset setting yields `NULL`, so no rows match and the query fails closed.
- `withTenant(tenantId, fn)` opens a transaction and runs `SELECT set_config('app.tenant_id', $1, true)`, which is transaction-local and safe with PgBouncer transaction pooling. The tenant ID comes from the authenticated principal only, never from a request body or path.
- **Composite foreign keys `(tenant_id, id)`**, so cross-tenant references can't be built even by buggy app code.
- The app layer also scopes every repository function by the principal's tenant. This is defence in depth, not the primary control.
- Non-DB stores: Redis keys start with `t:{tenant_id}:`. S3 keys start with `tenants/{tenant_id}/` and objects are encrypted with the tenant DEK. BullMQ and stream payloads carry `tenant_id`, and workers re-enter `withTenant` from it.
- **Residency:** a region cell is a full stack. Each tenant lives in exactly one cell. Cross-region replication is off by default.
- **Self-hosted:** the same schema and RLS with one tenant.

## Tests (required in CI)

1. The coverage test enumerates every table with a `tenant_id` column and asserts RLS is enabled, forced, and has a policy.
2. A generic isolation test seeds two tenants and, for every table, asserts that `prysm_app` under tenant A sees 0 rows of tenant B's data and cannot insert or update B's rows.
3. API-level tests: each endpoint class gets a request with tenant A's credentials that targets tenant B's resource IDs, and must return 404 (not 403, so existence doesn't leak).
4. A lint rule: no DB access outside `withTenant`, and the raw pool is not exported.

## Alternatives

- **Schema per tenant:** migrations fan out, the connection and catalog get bloated, and RLS is still needed for the shared tables.
- **Database per tenant:** the strongest isolation, but costly and operationally heavy at SaaS scale. It's effectively what self-hosted and a future "dedicated cell" tier give enterprise customers who require it.
