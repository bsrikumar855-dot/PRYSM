# ADR-0013: Global identity tables and the global key namespace

Status: **Proposed** · 2026-10-15. Amends ADR-0007 only where stated; everything else in ADR-0007 stands. Takes effect when the owner marks it Accepted.

## Context

ADR-0007 puts `tenant_id` and RLS on every tenant-scoped table, and prefixes every Redis key with `t:{tenant_id}:`. Login happens before the tenant is known, so identity needs a small set of tables and keys that cannot be tenant-scoped (ADR-0012).

## Decision

1. **Global tables are allowed, from a reviewed allowlist.** In M1 the allowlist is exactly `users`, `user_mfa_factors`, `mfa_recovery_codes`, `sessions` and `auth_events`. It lives in code in `packages/db` as a map from table name to a one-line reason, and a code-owner review plus a line in the PR's threat-model delta is needed to change it.
2. **Global tables hold identity, never tenant data.** No prompt, payload, policy, evidence or customer-configuration data goes in them. Secrets in them (MFA seeds) are field-encrypted with the auth DEK, not a tenant DEK.
3. **`tenants` is covered by RLS on `id`.** The coverage test checks it by name because it has no `tenant_id` column.
4. **Signup needs no privileged role.** The application picks the new tenant's UUID and inserts the tenant rows inside `withTenant(newId)`. `WITH CHECK` only allows that one id.
5. **Global tables are reached only through `withGlobal(fn)`,** exported by `packages/db`, which gives `fn` repositories for the allowlisted tables and nothing else. The raw pool stays unexported, and the ADR-0003 lint rule ("no DB access outside `withTenant`") gains one sanctioned alternative: `withGlobal`, whose repositories cannot name a tenant table.
6. **Valkey gains a global namespace `g:`** for state that exists before a tenant does: login rate limits, lockout counters and reset throttles, keyed by a keyed hash of the email or source, never the raw value. Tenant data stays under `t:{tenant_id}:`. Nothing else may use `g:`; a lint rule on key construction allows only the two prefixes.
7. **No `SECURITY DEFINER` functions and no RLS bypass** are introduced for identity.
8. **Pre-authentication tenant scoping for API keys.** ADR-0007 says the tenant id comes from the authenticated principal only. For an API key the tenant part of the string is read before the key is authenticated. This is the one sanctioned exception, and it is narrow: the value only selects which tenant scope `withTenant` opens for a lookup by `key_id`. Nothing from that scope is returned or acted on unless the constant-time hash compare succeeds. After success, the principal's tenant is `api_keys.tenant_id` read from the row, not the string. Every failure returns the same generic error (ADR-0012).

## Tests required (CI)

The allowlist is explicit in code and checked from both directions:

- **G1, exact match.** Query `pg_class` for tables in `public` that have no `tenant_id` column, excluding `tenants`. The set must **equal** the allowlist. A new global table that is not listed fails; a listed table that no longer exists fails.
- **G2, no tenant column.** No allowlisted table has a column named `tenant_id` (it would then need RLS and the standard policy).
- **G3, every entry justified.** Each allowlist entry has a non-empty reason.
- **G4, grants.** `prysm_app` has no `DELETE` on a global table except `sessions`; `prysm_platform` and `prysm_gateway_outbox` have no privilege on any global table.
- **G5, `tenants` policy.** `tenants` has RLS enabled and forced and a policy on `id`; under tenant A, `prysm_app` sees only tenant A's row.
- **G6, `withGlobal` surface.** A type-level and runtime test: `withGlobal` repositories do not expose any tenant table, and a lint fixture shows `withTenant`-only tables cannot be imported into `packages/db/src/global/`.
- **G7, key lookup.** Presenting tenant A's `key_id` with tenant B in the tenant part finds no row; a correct tenant with a wrong secret fails the compare; both return the same response and similar timing.
- **G8, `g:` namespace.** A key-construction lint test rejects any prefix other than `t:{tenant_id}:` and `g:`.

The existing ADR-0007 tests (coverage over `tenant_id` tables, generic isolation, API cross-tenant 404s) are unchanged and still apply to every tenant table.

## Consistency with ADR-0007

Checked line by line on 2026-10-15. ADR-0007 stands except where listed here.

| ADR-0007 rule                                                                     | Effect of this ADR                                                                                                 |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Shared schema, `tenant_id` on every **tenant-scoped** table, RLS enabled + forced | Unchanged. Global tables are by definition not tenant-scoped; G1 prevents a tenant table from hiding among them.   |
| Roles `prysm_owner`, `prysm_app`, `prysm_platform`; `prysm_app` is `NOBYPASSRLS`  | Unchanged. No new role in this ADR (the dev-only `prysm_test_admin` is in the M1 plan, not a runtime role).        |
| Policy `tenant_id = current_setting('app.tenant_id', true)::uuid`                 | Unchanged for tenant tables. `tenants` uses `id` (point 3).                                                        |
| `withTenant(tenantId, fn)`; tenant id from the authenticated principal only       | **Amended** in one place: the API-key lookup (point 8). Everything else still takes the tenant from the principal. |
| Composite FKs `(tenant_id, id)`                                                   | Unchanged. A tenant table references a global table (`memberships.user_id → users.id`) with a plain FK.            |
| App-layer scoping as defence in depth                                             | Unchanged.                                                                                                         |
| "Redis keys start with `t:{tenant_id}:`"                                          | **Amended**: also `g:` for pre-tenant state (point 6).                                                             |
| S3 keys `tenants/{tenant_id}/`; BullMQ payloads carry `tenant_id`                 | Unchanged.                                                                                                         |
| Test 1 (coverage), test 2 (generic isolation), test 3 (API 404s)                  | Unchanged and still required; G1–G8 are added beside them.                                                         |
| Test 4 / ADR-0003 lint: "no DB access outside `withTenant`"                       | **Amended**: also allowed through `withGlobal` for allowlisted tables only (point 5).                              |

When this ADR is Accepted, two places must be updated to match: `docs/ARCHITECTURE.md` §4 ("Every DB access goes through `withTenant`") and §9 invariant 1. ADR-0007 gets a header line "Amended by ADR-0013" in the same PR.

## Consequences

- Isolation for global tables rests on narrow grants, the allowlist test, and the absence of tenant data, not on RLS. That is a weaker mechanism than ADR-0007's, so the allowlist is kept deliberately short.
- The generic isolation test (ADR-0007, test 2) covers tenant tables only; global tables get their own tests (no cross-user reads through the API, sessions bound to the right user).
- `sessions.active_tenant_id` is a reference, not an enforcement point: the tenant used for a request is always derived from the session's membership.

## Alternatives

- **Make users per-tenant** (a user row per tenant): keeps everything under RLS but breaks one login across tenants, duplicates credentials and MFA, and makes login need the tenant first.
- **A `SECURITY DEFINER` login function:** an intentional RLS bypass. Rejected by the owner.
- **Run login as `prysm_platform`:** widens a role meant for audited platform jobs to every unauthenticated request.
