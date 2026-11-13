# ADR-0013: Global identity tables and the global key namespace

Status: **Accepted** · 2026-10-15. Amends ADR-0007 only where stated; everything else in ADR-0007 stands. **Amended 2026-10-28** (point 9, TRACKING F-49): `users` is split between `prysm_app` and a new `prysm_identity` role.

## Context

ADR-0007 puts `tenant_id` and RLS on every tenant-scoped table, and prefixes every Redis key with `t:{tenant_id}:`. Login happens before the tenant is known, so identity needs a small set of tables and keys that cannot be tenant-scoped (ADR-0012).

## Decision

1. **Global tables are allowed, from a reviewed allowlist.** In M1 the allowlist is exactly `users`, `user_mfa_factors`, `mfa_recovery_codes`, `sessions` and `auth_events`. It lives in code in `packages/db` as a map from table name to a one-line reason, and a code-owner review plus a line in the PR's threat-model delta is needed to change it. _Five at M1 completion; the allowlist grows with each migration: it holds only tables that exist, and a PR that adds a global table adds its entry and reason in the same commit._
2. **Global tables hold identity, never tenant data.** No prompt, payload, policy, evidence or customer-configuration data goes in them. Secrets in them (MFA seeds) are field-encrypted with the auth DEK, not a tenant DEK.
3. **`tenants` is covered by RLS on `id`.** The coverage test checks it by name because it has no `tenant_id` column.
4. **Signup needs no privileged role.** The application picks the new tenant's UUID and inserts the tenant rows inside `withTenant(newId)`. `WITH CHECK` only allows that one id.
5. **Global tables are reached only through `withGlobal(fn)`,** exported by `packages/db`, which gives `fn` repositories for the allowlisted tables and nothing else. The raw pool stays unexported, and the ADR-0003 lint rule ("no DB access outside `withTenant`") gains one sanctioned alternative: `withGlobal`, whose repositories cannot name a tenant table.
6. **Valkey gains a global namespace `g:`** for state that exists before a tenant does: login rate limits, lockout counters and reset throttles, keyed by a keyed hash of the email or source, never the raw value. Tenant data stays under `t:{tenant_id}:`. Nothing else may use `g:`; a lint rule on key construction allows only the two prefixes.
7. **No `SECURITY DEFINER` functions and no RLS bypass** are introduced for identity.
8. **Pre-authentication tenant scoping for API keys.** ADR-0007 says the tenant id comes from the authenticated principal only. For an API key the tenant part of the string is read before the key is authenticated. This is the one sanctioned exception, and it is narrow: the value only selects which tenant scope `withTenant` opens for a lookup by `key_id`. Nothing from that scope is returned or acted on unless the constant-time hash compare succeeds. After success, the principal's tenant is `api_keys.tenant_id` read from the row, not the string. Every failure returns the same generic error (ADR-0012).

9. **`users` is split by role (amendment, 2026-10-28, F-49).** Point 5 left `prysm_app` able to read every row of `users`, password salt and tag included, from inside `withTenant`, and able to write the password columns. That is closed in migration 0004 (migrations 0001 to 0003 are untouched):
   - **A second runtime role, `prysm_identity`,** `NOSUPERUSER NOBYPASSRLS`, provisioned by infrastructure like the other runtime roles (never by a migration, F-43). It holds `SELECT`, `INSERT` and a column-limited `UPDATE` on `users`, no `DELETE`, and **no privilege of any kind on any tenant table**. It is not a member of any other role and owns nothing.
   - **`withGlobal` connects as `prysm_identity`** through a second, small pool (`DATABASE_URL_IDENTITY`, optional `identityConnectionString` on `createDb`). `withTenant` stays on `prysm_app`. The text guard on tenant-table names stays as defence in depth; the controls are now the database privileges.
   - **`prysm_app` keeps only `SELECT` on four columns of `users`:** `id`, `email`, `email_verified_at`, `created_at` (the `safe` class). No `INSERT`, `UPDATE`, `DELETE`, and no password column. Every other column (`password_*`, `failed_logins`, `locked_until`, `disabled_at`, `updated_at`) is `secret`, reachable only through `withGlobal`. `USERS_COLUMN_CLASSES` in `packages/db` classifies every column, and a test fails if a column is added without a class.
   - **`users` has RLS enabled and forced.** `prysm_app` has one `SELECT` policy: a row is visible only if its user has a membership in the tenant the transaction is scoped to (`app_tenant_id()`), so with no tenant set it sees nothing. `prysm_identity` has one `FOR ALL` policy with `USING (true)`, because login and signup run before a tenant is known; its grants are the limit on what it can do. There is still no `SECURITY DEFINER` function and no `BYPASSRLS` role.
   - A member list now shows only members of the current tenant; a platform view of all users is not available to `prysm_app` and would need its own reviewed path.

## Tests required (CI)

The allowlist is explicit in code and checked from both directions:

- **G1, exact match.** Query `pg_class` for tables in `public` that have no `tenant_id` column, excluding `tenants`. The set must **equal** the allowlist. A new global table that is not listed fails; a listed table that no longer exists fails.
- **G2, no tenant column.** No allowlisted table has a column named `tenant_id` (it would then need RLS and the standard policy).
- **G3, every entry justified.** Each allowlist entry has a non-empty reason.
- **G4, grants.** No role has `DELETE` on `users`; `prysm_app` has no write privilege on it; `prysm_platform` and `prysm_gateway_outbox` have no privilege on any global table. (`DELETE` on `sessions` stays a PR 7 decision.)
- **G5, `tenants` policy.** `tenants` has RLS enabled and forced and a policy on `id`; under tenant A, `prysm_app` sees only tenant A's row.
- **G6, `withGlobal` surface.** A type-level and runtime test: `withGlobal` repositories do not expose any tenant table, and a lint fixture shows `withTenant`-only tables cannot be imported into `packages/db/src/global/`.
- **G7, key lookup.** Presenting tenant A's `key_id` with tenant B in the tenant part finds no row; a correct tenant with a wrong secret fails the compare; both return the same response and similar timing.
- **G8, `g:` namespace.** A key-construction lint test rejects any prefix other than `t:{tenant_id}:` and `g:`.
- **G10, `users` column classes (F-49).** Every `users` column is classified `safe` or `secret` in code and the classes cover the catalog exactly; `prysm_app` can `SELECT` exactly the safe columns and has no `INSERT`, `UPDATE` or `REFERENCES` on any column; the password columns cannot be read by name, by `SELECT *` or through an expression.
- **G11, members only (F-49).** Inside `withTenant(A)`, `prysm_app` sees only users with a membership in tenant A (not another tenant's users, not users with no tenant), cannot find a non-member by id or email, sees nothing with no tenant set, and cannot `INSERT`, `UPDATE`, `DELETE` or `TRUNCATE` `users`.
- **G12, the identity role is confined (F-49).** `prysm_identity` can read and update the password columns but cannot delete users or change an id, holds no privilege on any tenant table (table or column level) or on `app_tenant_id()`, and is refused ("permission denied") when a statement that walks around the `withGlobal` guard names a tenant table. Mutation-checked: re-granting `password_salt` to `prysm_app`, loosening the `users` policy and granting `prysm_identity` `SELECT` on `memberships` each fail a named test.
- **G9, signup cannot target an existing tenant.** The server generates the tenant id with a CSPRNG and inserts the `tenants` row first; a test that forces an existing id makes the transaction abort at that insert and leaves no `memberships` row in the other tenant.

The existing ADR-0007 tests (coverage over `tenant_id` tables, generic isolation, API cross-tenant 404s) are unchanged and still apply to every tenant table.

## Consistency with ADR-0007

Checked line by line on 2026-10-15. ADR-0007 stands except where listed here.

| ADR-0007 rule                                                                     | Effect of this ADR                                                                                                                                                           |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared schema, `tenant_id` on every **tenant-scoped** table, RLS enabled + forced | Unchanged. Global tables are by definition not tenant-scoped; G1 prevents a tenant table from hiding among them.                                                             |
| Roles `prysm_owner`, `prysm_app`, `prysm_platform`; `prysm_app` is `NOBYPASSRLS`  | **Amended (point 9)**: one new runtime role, `prysm_identity` (`NOSUPERUSER NOBYPASSRLS`, no tenant-table privilege). The dev-only `prysm_test_admin` is not a runtime role. |
| Policy `tenant_id = current_setting('app.tenant_id', true)::uuid`                 | Unchanged for tenant tables. `tenants` uses `id` (point 3).                                                                                                                  |
| `withTenant(tenantId, fn)`; tenant id from the authenticated principal only       | **Amended** in one place: the API-key lookup (point 8). Everything else still takes the tenant from the principal.                                                           |
| Composite FKs `(tenant_id, id)`                                                   | Unchanged. A tenant table references a global table (`memberships.user_id → users.id`) with a plain FK.                                                                      |
| App-layer scoping as defence in depth                                             | Unchanged.                                                                                                                                                                   |
| "Redis keys start with `t:{tenant_id}:`"                                          | **Amended**: also `g:` for pre-tenant state (point 6).                                                                                                                       |
| S3 keys `tenants/{tenant_id}/`; BullMQ payloads carry `tenant_id`                 | Unchanged.                                                                                                                                                                   |
| Test 1 (coverage), test 2 (generic isolation), test 3 (API 404s)                  | Unchanged and still required; G1–G8 are added beside them.                                                                                                                   |
| Test 4 / ADR-0003 lint: "no DB access outside `withTenant`"                       | **Amended**: also allowed through `withGlobal` for allowlisted tables only (point 5).                                                                                        |

`docs/ARCHITECTURE.md` §4 and §9 were updated to match in the PR that accepted this ADR, and ADR-0007 carries a header line "Amended by ADR-0013".

## Consequences

- Isolation for global tables rests on narrow grants, the allowlist test, and the absence of tenant data. `users`, the one that holds secrets, additionally has RLS and a separate role (point 9); the other global tables get the same treatment when they arrive if they hold secrets. That is a weaker mechanism than ADR-0007's for tables without RLS, so the allowlist is kept deliberately short.
- The generic isolation test (ADR-0007, test 2) covers tenant tables only; global tables get their own tests (no cross-user reads through the API, sessions bound to the right user).
- `sessions.active_tenant_id` is a reference, not an enforcement point: the tenant used for a request is always derived from the session's membership.

## Alternatives

- **Make users per-tenant** (a user row per tenant): keeps everything under RLS but breaks one login across tenants, duplicates credentials and MFA, and makes login need the tenant first.
- **A `SECURITY DEFINER` login function:** an intentional RLS bypass. Rejected by the owner.
- **Run login as `prysm_platform`:** widens a role meant for audited platform jobs to every unauthenticated request.
