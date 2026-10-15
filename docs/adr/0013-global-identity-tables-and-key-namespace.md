# ADR-0013: Global identity tables and the global key namespace

Status: **Proposed** · 2026-10-15. Amends ADR-0007 only where stated; everything else in ADR-0007 stands. Takes effect when the owner marks it Accepted.

## Context

ADR-0007 puts `tenant_id` and RLS on every tenant-scoped table, and prefixes every Redis key with `t:{tenant_id}:`. Login happens before the tenant is known, so identity needs a small set of tables and keys that cannot be tenant-scoped (ADR-0012).

## Decision

1. **Global tables are allowed, from a reviewed allowlist.** In M1 the allowlist is `users`, `user_mfa_factors`, `mfa_recovery_codes`, `sessions` and `auth_events`. A table without a `tenant_id` column that is not on the allowlist fails CI. The allowlist lives in `packages/db`, and adding to it needs a code-owner review and a line in the PR's threat-model delta.
2. **Global tables hold identity, never tenant data.** No prompt, payload, policy, evidence or customer-configuration data goes in them. Secrets in them (MFA seeds) are field-encrypted with the auth DEK, not a tenant DEK.
3. **`tenants` is covered by RLS on `id`.** The coverage test checks it explicitly because it has no `tenant_id` column.
4. **Signup needs no privileged role.** The application picks the new tenant's UUID and inserts the tenant rows inside `withTenant(newId)`. `WITH CHECK` only allows that one id.
5. **Valkey gains a global namespace `g:`** for state that exists before a tenant does: login rate limits, lockout counters and password-reset throttles, keyed by a keyed hash of the email or source, never the raw value. Tenant data stays under `t:{tenant_id}:`. Nothing else may use `g:`; a lint rule on key construction enforces the two prefixes.
6. **No `SECURITY DEFINER` functions and no RLS bypass** are introduced for identity. API-key lookup is `withTenant(<tenant from key>)`, then a lookup by key id.

## Consequences

- Isolation for global tables rests on narrow grants, the allowlist test, and the absence of tenant data, not on RLS. That is a weaker mechanism than ADR-0007's, so the allowlist is kept deliberately short.
- The generic isolation test (ADR-0007, test 2) covers tenant tables only; global tables get their own tests (no cross-user reads through the API, sessions bound to the right user).
- `sessions.active_tenant_id` is a reference, not an enforcement point: the tenant used for a request is always derived from the session's membership.

## Alternatives

- **Make users per-tenant** (a user row per tenant): keeps everything under RLS but breaks one login across tenants, duplicates credentials and MFA, and makes login need the tenant first.
- **A `SECURITY DEFINER` login function:** an intentional RLS bypass. Rejected by the owner.
- **Run login as `prysm_platform`:** widens a role meant for audited platform jobs to every unauthenticated request.
