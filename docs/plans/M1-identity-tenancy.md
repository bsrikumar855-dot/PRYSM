# M1 plan: Identity and tenancy

Status: **Proposed, owner answers recorded 2026-10-15; awaiting approval of the dependency list (Q4) and ADR-0012 (Q7).** No M1 code has been written. CLAUDE.md requires an approved plan before each milestone starts.

Prerequisite (met): M0 is merged and all 7 CI jobs are green on `main` ([run 38678172559](https://github.com/bsrikumar855-dot/PRYSM/actions/runs/38678172559), after [PR #16](https://github.com/bsrikumar855-dot/PRYSM/pull/16)). **No M1 code starts until ADR-0012 is Accepted.**

## 1. Scope

**Gate (TRACKING §1):** sign up → MFA → create app → API key, and the cross-tenant test suite passes.

| ID   | Requirement                                                           | In this plan                                                       |
| ---- | --------------------------------------------------------------------- | ------------------------------------------------------------------ |
| F-12 | RLS on every tenant table + coverage test + generic isolation test    | Yes                                                                |
| F-13 | Envelope encryption: per-tenant DEK, KMS adapter interface, local KMS | Yes                                                                |
| F-15 | Field-level encryption for sensitive columns                          | Yes (first users: MFA secrets, SSO config)                         |
| F-18 | OpenAPI 3.1 generated, committed, drift and breaking-change check     | Yes                                                                |
| F-19 | CSP and secure headers (api, web)                                     | Yes                                                                |
| F-21 | Lint rule against unvalidated route handlers                          | Yes (the M0 half is done)                                          |
| F-22 | Integration tests (one local + CI harness, no Testcontainers)         | Yes (Q6, wording change pending approval)                          |
| F-23 | Playwright e2e + axe on critical flows                                | Yes (first UI)                                                     |
| I-01 | Tenants, users, memberships                                           | Yes (needed by the gate)                                           |
| I-02 | Password (Argon2id) + MFA                                             | Password + TOTP. WebAuthn deferred (Q1)                            |
| I-06 | RBAC with an exhaustive permission-matrix test                        | Yes (needed to create apps and keys safely)                        |
| I-07 | Scoped, hashed, rotatable API keys                                    | Yes (needed by the gate)                                           |
| I-08 | Admin AuditLog, append-only                                           | Yes                                                                |
| I-09 | Tenant settings: retention, residency, SSO config                     | Settings storage only; retention enforcement is M2                 |
| I-11 | Separation-of-duties primitive                                        | Primitive only (`assertNotSelfApproval`); no approval workflow yet |
| I-03 | OIDC SSO                                                              | **Deferred** (Q1, owner 2026-10-15) to a follow-up after the gate  |

I-01, I-02, I-06, I-07, I-08, I-09 and I-11 are in TRACKING's M1 but were not in the scope list in the request. I included the ones the gate cannot work without and flagged the rest.

Out of scope: SAML and SCIM (M11), key-management UI (I-10, M11), cloud KMS adapters (F-14, M11), evidence records for AuditLog entries (M2, tracked as a TODO below), gateway key lookup (M4).

## 2. What exists today (M0)

- `packages/db`: `createPool`, `ping`, `findRlsGaps` (the RLS coverage query), a baseline migration, and an empty `schema/index.ts`. **No `withTenant` yet** and no lint rule banning the raw pool (both are required by ADR-0003/0007).
- Dev roles from `infra/docker/postgres/init/00-dev-roles.sql`: `prysm_owner`, `prysm_app`, `prysm_platform`, `prysm_gateway_outbox`. The runtime roles are `NOSUPERUSER NOBYPASSRLS` and own nothing.
- `apps/api` is a Fastify skeleton with health and readiness only. `apps/web` has only `/healthz` and `/readyz`.
- `packages/platform` has the server factory, zod config loader, pino logger with a field allowlist, and OTel setup.
- Dependencies present: fastify, zod, drizzle-orm, pg, ioredis. **Nothing for password hashing, TOTP, cookies, OpenAPI or Playwright.**

## 3. Domain and schema

All tenant-scoped tables have `tenant_id`, a composite key `(tenant_id, id)`, composite foreign keys, and `ENABLE` + `FORCE ROW LEVEL SECURITY` with a hand-written policy (ADR-0007). Migrations are forward-only SQL; `drizzle-kit generate` drafts the DDL and I hand-write the RLS, grants and triggers in separate numbered files.

### 3.1 Two kinds of table

Identity creates a chicken-and-egg problem: at login we don't yet know the tenant. The plan splits tables like this:

- **Global tables** (no `tenant_id`, no RLS): `users`, `user_mfa_factors`, `mfa_recovery_codes`, `sessions`, `auth_events`. They hold identity, not tenant data. This is a deliberate extension of ADR-0007, so it needs an ADR amendment (see §4.5). A new test asserts that every table _without_ `tenant_id` is on a reviewed allowlist, so a tenant table can't slip out of RLS by forgetting the column.
- **Tenant tables**: everything else.

### 3.2 Tables

| Table                | Scope  | Key columns                                                                                                                                                                                               | Notes                                                                                                                                                         |
| -------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tenants`            | tenant | `id`, `slug` (unique), `name`, `region`, `status`, `created_at`                                                                                                                                           | Identity of the tenant. Policy: `id = current_setting('app.tenant_id')`. The coverage test is extended to cover it explicitly (it has no `tenant_id` column). |
| `tenant_settings`    | tenant | `tenant_id` PK, `retention_mode` (`full\|redacted\|metadata`), `retention_days`, `sso_config_enc`                                                                                                         | I-09. `sso_config_enc` uses field encryption.                                                                                                                 |
| `tenant_keys`        | tenant | `tenant_id`, `id`, `version`, `wrapped_dek` (bytea), `kek_id`, `algorithm`, `created_at`, `retired_at`                                                                                                    | One active DEK per tenant. Old versions kept for decrypt.                                                                                                     |
| `users`              | global | `id`, `email` (citext, unique), `email_verified_at`, `password_hash`, `password_params`, `failed_logins`, `locked_until`, `disabled_at`, `created_at`                                                     | No tenant data.                                                                                                                                               |
| `memberships`        | tenant | `tenant_id`, `id`, `user_id` → `users`, `role`, `status`, `created_at`; unique `(tenant_id, user_id)`                                                                                                     | `role` is an enum: owner, admin, compliance_manager, engineer, reviewer, auditor.                                                                             |
| `user_mfa_factors`   | global | `id`, `user_id`, `type` (`totp`), `secret_enc`, `confirmed_at`, `last_used_step`                                                                                                                          | Encrypted with the **auth DEK**, not a tenant DEK (see §5).                                                                                                   |
| `mfa_recovery_codes` | global | `id`, `user_id`, `code_hash`, `used_at`                                                                                                                                                                   | 10 codes, shown once.                                                                                                                                         |
| `sessions`           | global | `id`, `token_hash`, `user_id`, `active_tenant_id`, `mfa_verified_at`, `created_at`, `last_seen_at`, `idle_expires_at`, `abs_expires_at`, `revoked_at`                                                     | Store only the SHA-256 of the token.                                                                                                                          |
| `applications`       | tenant | `tenant_id`, `id`, `name`, `environment`, `created_by` (composite FK to `memberships`), `created_at`                                                                                                      | The minimum the gate needs. Shaped to be extended by A-01 in M5 (expand/contract, no rename).                                                                 |
| `api_keys`           | tenant | `tenant_id`, `id`, `application_id` (composite FK), `key_id` (public, unique), `secret_hash`, `scopes[]`, `name`, `created_by`, `expires_at`, `last_used_at`, `revoked_at`, `replaces_key_id`             | No `DELETE` grant. Revocation is an `UPDATE`.                                                                                                                 |
| `admin_audit_log`    | tenant | `tenant_id`, `id` (bigint identity), `occurred_at`, `actor_user_id`, `actor_membership_id`, `session_id`, `mfa_used`, `action`, `target_type`, `target_id`, `request_id`, `meta` (small JSON, no secrets) | Append-only (see §3.4).                                                                                                                                       |
| `auth_events`        | global | `id`, `occurred_at`, `kind` (login_failed, lockout, mfa_failed, signup), `email_hash`, `user_id?`, `request_id`                                                                                           | For lockout and abuse analysis before a tenant is known. Contains a keyed hash of the email, never the address.                                               |
| `idempotency_keys`   | tenant | `tenant_id`, `key`, `request_hash`, `response_status`, `response_body_ref`, `created_at`                                                                                                                  | ADR-0002 requires `Idempotency-Key` on mutating endpoints. Short TTL.                                                                                         |

Composite FKs: `memberships`, `applications`, `api_keys`, `tenant_settings`, `tenant_keys`, `admin_audit_log` reference each other only through `(tenant_id, id)`, so a cross-tenant reference can't be built even by buggy code. `memberships.user_id → users.id` is a plain FK because `users` is global.

### 3.3 Roles and grants

No new database roles. Each table's grants are explicit (the baseline migration already forbids default privileges):

| Role                   | Grants in M1                                                                                                                                                                                                                                                                                             |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prysm_app`            | `SELECT, INSERT, UPDATE` on tenant tables except `admin_audit_log` and `tenant_keys` (see below). `SELECT, INSERT, UPDATE` on the global identity tables. `INSERT` on `auth_events`. **No `DELETE`** anywhere except `idempotency_keys` and `sessions` (expiry cleanup). Never `BYPASSRLS`, never owner. |
| `prysm_platform`       | Nothing new in M1. Signup does **not** need it (below).                                                                                                                                                                                                                                                  |
| `prysm_gateway_outbox` | Nothing in M1 (outbox is M4).                                                                                                                                                                                                                                                                            |

`admin_audit_log`: `INSERT, SELECT` only. `tenant_keys`: `INSERT, SELECT`, plus `UPDATE` limited to the `retired_at` column.

### 3.4 RLS policies (hand-written SQL)

Standard policy from ADR-0007 on every tenant table:

```sql
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON memberships
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
```

`tenants` uses `id` instead of `tenant_id`. An unset setting gives `NULL`, so nothing matches and the query fails closed.

**Signup without a privileged role.** The application generates the new tenant's UUID, opens `withTenant(newId, …)`, and inserts the `tenants`, `tenant_settings`, `tenant_keys` and `memberships` rows in one transaction. `WITH CHECK` passes only for that one id, so signup can create a tenant it names but can't touch anyone else's. The `users` row is created first, outside tenant scope, because `users` is global.

**Audit log immutability:** a `BEFORE UPDATE OR DELETE` trigger raises an exception for every role (no exception path in M1, since retention is M2), plus the grant above. Both are tested.

### 3.5 `withTenant`

`withTenant(tenantId, fn)` in `packages/db`: opens a transaction, runs `SELECT set_config('app.tenant_id', $1, true)`, and passes a transaction-scoped client to `fn`. It is the only exported way to reach tenant tables; the raw pool is not exported. Two lint rules (ESLint, in the repo's flat config):

1. no import of the raw pool outside `packages/db` (ADR-0003);
2. no DB access outside `withTenant` for tenant tables.

The tenant id comes from the authenticated principal only, never from a path, body or header.

## 4. Auth design

### 4.1 Build vs embed

The adr README already reserves an M1 ADR for "identity provider build-vs-embed". **A new ADR-0012 is required before code.**

| Option                                                     | For                                                                                                                                        | Against                                                                                                                                       |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Thin in-house layer on vetted primitives (recommended)** | Fits RLS, composite keys, the audit log and the zod/OpenAPI pipeline exactly. One process, self-hosted friendly. Small dependency surface. | We own the session and MFA logic, which is security-critical. Mitigated by tests, ASVS L2 mapping and using libraries for all cryptography.   |
| Auth library (e.g. better-auth, Auth.js)                   | Less code up front, more built-in flows.                                                                                                   | Brings its own tables and conventions that must be bent to RLS and composite FKs. Plugin sprawl. Harder to prove tenant isolation.            |
| Separate IdP service (Keycloak, Ory Kratos)                | Mature feature set.                                                                                                                        | **New stateful external service**, heavy for self-hosted, and a second user model to reconcile with RLS. Needs your approval under CLAUDE.md. |

### 4.2 Passwords

- **Argon2id**, parameters stored with each hash so we can rehash on login. Start at the OWASP minimum (m = 19 MiB, t = 2, p = 1) as a floor and tune up on the reference machine so a hash takes roughly 100 ms.
- Minimum length 12, no composition rules, maximum 128. Breached-password check against a modest **offline** list (Q3); no HIBP or other external call.
- Login does constant-work comparison even for unknown emails (dummy hash) and returns one generic error, so accounts can't be enumerated.
- Lockout with exponential backoff per account and per source, in Valkey, plus `auth_events` rows. Rate limits per route.

### 4.3 Sessions

- Opaque 256-bit random token in a `__Host-` cookie (`HttpOnly; Secure; SameSite=Lax; Path=/`). Only the SHA-256 is stored in `sessions`.
- Idle timeout 30 min and absolute 12 h (Q8, approved). Rotated on login, on MFA success, on tenant switch and on privilege change. Revocable, and listed per user.
- A session starts as `mfa_pending` and can call **only** the MFA enrol/verify endpoints until `mfa_verified_at` is set. MFA is mandatory for every account (Q9, approved).
- CSRF: `SameSite=Lax`, an `Origin`/`Sec-Fetch-Site` check on mutations, and a double-submit token (THREAT_MODEL 3.2).
- Alternative considered: sessions in Valkey. Rejected for M1 because Valkey runs with `appendfsync everysec` (up to about 1 s of loss), and session revocation is something we want to audit. Postgres costs one indexed lookup per request, which is fine for the console and fits M1's load.

The web app and API share one browser origin so the `__Host-` cookie works: Next.js proxies `/api/v1/*` to the api service (a rewrite). The web app still talks only to the api, as ARCHITECTURE requires.

### 4.4 MFA

- **TOTP** (RFC 6238; SHA-1, 6 digits, 30 s, ±1 step window), 160-bit secret, replay protection through `last_used_step`, 10 single-use recovery codes stored as SHA-256 (they are high-entropy random, so a slow hash adds nothing). Secrets are field-encrypted.
- **WebAuthn** (named in I-02) and OIDC (I-03) are deferred to follow-ups after the gate (Q1, owner 2026-10-15); TRACKING keeps them at M1 until the scope-change log is updated in PR 1.
- Alternatives considered: SMS or email codes (rejected: phishable and need a delivery service), TOTP only forever (rejected in the long term, since I-02 lists WebAuthn).

### 4.5 API keys

- Layout: `prysm_<tenant>_<key_id>_<secret>`. `<tenant>` is the tenant UUID, encoded; `<key_id>` is a random public id; `<secret>` is 256 bits from the OS CSPRNG. The `prysm_` prefix lets secret scanners (including a gitleaks rule we add) find leaked keys. The string is opaque: nothing in it is signed, decoded for trust or self-describing, and no checksum is defined (ADR-0012 lists this as the one identifier layout we define).
- Storage: `key_id` (public, indexed) and `secret_hash = SHA-256("prysm.apikey.v1\n" ‖ full key)`. A fast hash is correct here because the secret has 256 bits of entropy (unlike a password), and the gateway needs microsecond lookups in M4. Comparison is constant-time. The key is shown **once** at creation.
- Scopes: `gateway`, `sdk`, `collector`, `ingest`, scoped to one application and one environment. Rotation creates a new key that records `replaces_key_id`; the old key keeps working for a grace period the caller chooses, then is revoked.
- **Lookup (Q10, owner-decided):** split the presented key into `<tenant>`, `<key_id>`, `<secret>`; call `withTenant(<tenant>)`; select the row by `key_id` under RLS; compare `SHA-256(domain ‖ full key)` to `secret_hash` in constant time. A forged tenant part finds no row or a hash mismatch. **`SECURITY DEFINER` functions are never used** and no RLS bypass is added.
- Alternative considered: HMAC-SHA256 with a server-side pepper. Better against a database-only leak, but it needs pepper management and rotation. Listed as a hardening option for M11.

### 4.6 Things that need a new ADR or an ADR amendment

| Item                                                                                 | Why                                                                                                                                                                             |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ADR-0012: identity build vs embed** (new)                                          | Reserved in the ADR index. §4.1 is the draft.                                                                                                                                   |
| **ADR-0007 amendment** (a new ADR superseding the relevant parts, per the ADR rules) | Allows global identity tables without RLS, and a global `g:` Valkey key namespace for pre-tenant rate limits and lockouts (ADR-0007 says all keys start with `t:{tenant_id}:`). |
| Auth-DEK purpose in the envelope design                                              | MFA secrets belong to a user who may be in several tenants (§5).                                                                                                                |

## 5. Envelope encryption (F-13, F-15)

New internal package `packages/crypto` (no external dependency; `node:crypto` only). Approved (Q5); CLAUDE.md's layout section is updated in PR 1.

```ts
interface KmsAdapter {
  readonly kekId: string; // identifies the key-encryption key, stored with each wrapped DEK
  /** Wraps a 32-byte DEK. `context` is bound as AAD, so a wrapped DEK can't be moved to another tenant. */
  wrapKey(dek: Uint8Array, context: KeyContext): Promise<Uint8Array>;
  unwrapKey(wrapped: Uint8Array, context: KeyContext): Promise<Uint8Array>;
}
type KeyContext = { purpose: 'tenant' | 'auth'; tenantId?: string; version: number };
```

- **DEK per tenant:** 256-bit, generated at tenant creation, stored wrapped in `tenant_keys`. The unwrapped DEK lives in a bounded in-process cache (short TTL) and is never logged or persisted. A separate **auth DEK** (`purpose: 'auth'`) protects global-table secrets such as MFA seeds.
- **Local adapter:** AES-256-GCM key wrap with a KEK read from a file (`KMS_LOCAL_KEY_FILE`). It refuses to start if the file is group- or world-readable. For local dev we generate a throwaway key file into a git-ignored path; the file never goes in `.env.example`. A PKCS#11 variant is M11. Cloud adapters are F-14 (M11).
- **Field encryption:** AES-256-GCM, random 96-bit nonce, and AAD = `tenant_id | table | column | row_id`, so a ciphertext copied into another row, column or tenant fails to decrypt. Stored format: `enc1.<dek_version>.<nonce>.<ciphertext+tag>` (base64url). A Drizzle custom column type `encryptedText` does this transparently.
- **Rotation primitive:** `rotateDek(tenant)` creates a new version and marks the old one retired; reads decrypt with the version in the ciphertext, and a re-encrypt job is M11. NIST limits random-nonce GCM to about 2^32 messages per key, so the per-DEK write counter is tracked and rotation is forced before that.
- **Crypto-shredding** (E-10) is M11, but the design already supports it: delete the tenant's DEK versions and the ciphertext is unreadable.
- Alternative considered: libsodium/age for field encryption. Fine, but they'd add a dependency for something `node:crypto` does well, and we need the AAD binding.

## 6. API, OpenAPI, headers, validation (F-18, F-19, F-21)

- Fastify with `fastify-type-provider-zod`; schemas live in `packages/core-types` (ADR-0002). Errors use RFC 9457 `application/problem+json`; cursor pagination; `Idempotency-Key` on mutating routes.
- Generate `docs/api/openapi.json`, commit it, and have CI regenerate it and fail on any diff. `oasdiff` flags breaking changes against `main`, and Spectral requires a description on every operation and schema.
- **F-21 route lint:** an ESLint rule (local plugin) fails any route registered without a `schema` that validates params, query, body and response. A `// eslint-disable` needs an inline justification, as CLAUDE.md requires for `any`.
- **api headers:** `@fastify/helmet` plus an explicit no-store on auth responses. **web:** CSP with a per-request nonce set in Next middleware (no `unsafe-inline`), `frame-ancestors 'none'`, `X-Content-Type-Options`, `Referrer-Policy`, and `Permissions-Policy`. A test asserts the headers on every route.
- Mass assignment: schemas are `.strict()`. `tenant_id` and `role` are never accepted from a request body.
- The `prysm_app` principal is built only in an auth plugin and attached to the request as `principal = {userId, membershipId, tenantId, role, sessionId | apiKeyId, mfa}`.

## 7. Authorization (I-06, I-11)

- A single `authz` module (inside `packages/core-types`, per Q5) defines `Permission` and a `ROLE_PERMISSIONS` map.
- **Exhaustive matrix test:** it iterates roles × permissions and compares against a reviewed fixture (a table committed in the repo). Adding a permission without deciding every role fails the test. The auditor role holds only read permissions, and a test asserts it.
- Every route declares the permission it requires, and the route-lint rule (F-21) fails a route that doesn't.
- `assertNotSelfApproval(authorId, approverId)` is the I-11 primitive. Callers arrive in M5/M6.

## 8. First UI (F-23)

Flows, all behind CSP and with axe checks:

1. Sign up (email, password) → forced MFA enrolment (QR or secret + code) → recovery codes shown once.
2. Log in → MFA challenge → recovery-code fallback.
3. Applications list and create.
4. API keys: create (shown once, copy), rotate, revoke.
5. Log out and session expiry.

Web uses React forms with server-side validation reusing the zod schemas. No component library is added in M1; plain accessible HTML is enough for these five screens.

## 9. Test plan

| Layer                                | What it proves                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **RLS coverage**                     | Every table with `tenant_id` (and `tenants`) has RLS enabled and forced and at least one policy. Every table _without_ `tenant_id` is on the reviewed allowlist.                                                                                                                                                                                                                                                                                                                              |
| **Generic isolation (core of F-12)** | Generated from `pg_class`, so a new table is covered automatically. Seeds tenants A and B, then for **every tenant table** asserts: under A, `prysm_app` sees 0 of B's rows, can't `INSERT` a row with B's `tenant_id`, can't `UPDATE`/`DELETE` B's rows, and with `app.tenant_id` unset sees 0 rows. A second test shows composite FKs reject a cross-tenant reference. A canary test fails if the generator finds a tenant table with no seed fixture, so tables can't be silently skipped. |
| **Role safety**                      | `prysm_app` is `NOBYPASSRLS`, not owner, not superuser. `admin_audit_log` rejects `UPDATE` and `DELETE` for `prysm_app` (grant) and for the owner (trigger).                                                                                                                                                                                                                                                                                                                                  |
| **API cross-tenant (ADR-0007 #3)**   | For each endpoint class, a request with tenant A's credentials aimed at tenant B's resource id returns **404** (not 403), and the response body and timing don't reveal existence.                                                                                                                                                                                                                                                                                                            |
| **Happy path**                       | Sign up → enrol MFA → log in → create app → create key → key authenticates → rotate → revoke → revoked key fails.                                                                                                                                                                                                                                                                                                                                                                             |
| **Auth failure paths**               | Wrong password, unknown email (same response and similar timing), lockout and recovery, expired and revoked session, `mfa_pending` session blocked from everything else, reused TOTP step rejected, reused recovery code rejected, CSRF/Origin mismatch rejected, mass-assignment of `tenant_id`/`role` rejected.                                                                                                                                                                             |
| **RBAC**                             | The exhaustive role × permission matrix. Auditor can't write. Engineer can't manage keys beyond their permission.                                                                                                                                                                                                                                                                                                                                                                             |
| **Crypto**                           | Wrap/unwrap round trip; wrong-tenant context fails; tampered ciphertext, tag, AAD and version fail; copying a ciphertext into another row/column/tenant fails; local adapter refuses a world-readable KEK; known-answer tests for GCM.                                                                                                                                                                                                                                                        |
| **Secrets never leak**               | A canary password, TOTP secret, session token and API key are pushed through every flow, then the log output, error bodies, OTel traces and DB audit rows are scanned for them (extends the M0 canary tests).                                                                                                                                                                                                                                                                                 |
| **Headers and OpenAPI**              | Header assertions per route. The OpenAPI drift check and `oasdiff` run in CI.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Lint rules**                       | Rule tests for unvalidated route, raw pool import and DB access outside `withTenant`, each with a passing and a failing fixture.                                                                                                                                                                                                                                                                                                                                                              |
| **E2E + a11y**                       | Playwright runs the five UI flows against the real stack; axe reports zero violations on each page.                                                                                                                                                                                                                                                                                                                                                                                           |
| **Gate**                             | `scripts/verify-m1.mjs` runs the full gate and the cross-tenant suite against a running stack.                                                                                                                                                                                                                                                                                                                                                                                                |

**Threat model delta for M1** (to land in `THREAT_MODEL.md` §6 with the milestone): new trust boundary is the browser → web → api session path; new assets are password hashes, MFA seeds and API-key hashes (A7); the global auth tables are an intentional exception to tenant RLS. The STRIDE rows for api/web in §3.2 become implemented controls, each linked to a test above.

## 10. Test harness (F-22, Q6)

One harness for local and CI (owner, 2026-10-15). No Testcontainers.

- Suites run against the stack that already exists: the compose services locally (`pnpm infra:up`) and the same services in the CI job. Nothing starts or stops containers.
- **Postgres:** a one-time migrated **template database** (`prysm_template`, created by `pnpm db:migrate` against it). Each suite creates its own database with `CREATE DATABASE prysm_t_<suite>_<random> TEMPLATE prysm_template`, connects as `prysm_app` and `prysm_owner` to it, and drops it afterwards (a global-setup sweep drops leftovers older than an hour). This gives full isolation, including for the cross-tenant suite, and `FORCE ROW LEVEL SECURITY` runs against a real schema.
- **Needs a role with `CREATEDB`:** the dev roles in `infra/docker/postgres/init/00-dev-roles.sql` have `NOCREATEDB`. PR 2 adds a dev- and CI-only `prysm_test_admin` role (`CREATEDB`, no access to production roles' objects) to that file and to its CI mirror. This is an infrastructure change in a dev script; runtime roles are unchanged. The init script only runs on a fresh volume, so existing local volumes need `docker compose down -v` once.
- **Valkey:** every suite uses a unique key prefix and deletes it at the end. **SeaweedFS:** a unique bucket prefix per suite.
- **Proposed TRACKING wording (needs your approval, drafted in PR 1):**
  - Old F-22: "Integration tests with Testcontainers (Postgres, Valkey, SeaweedFS)".
  - New F-22: "Integration tests against the compose/CI Postgres, Valkey and SeaweedFS through one harness for local and CI. Each suite gets its own database cloned from a migrated template (`CREATE DATABASE … TEMPLATE`), a unique Valkey key prefix and a unique bucket prefix. No Testcontainers."
  - Reason recorded in §3 of TRACKING: Testcontainers cannot clean up on the owner's Docker (snap daemon denies stop/remove), and one harness avoids two ways to run the same test.

## 11. PR breakdown

Small, ordered PRs, each branching from a green `main`. "Verify" is the command that must pass before the PR is opened. Scripts that don't exist yet are added by the PR that lists them.

| #   | PR                                                                                                                                                                                                                          | Verify                                                            |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 1   | **Docs only:** this plan, ADR-0012 and ADR-0013 (drafts, to be Accepted), CLAUDE.md layout update, TRACKING updates (F-22 wording, scope-change log), threat-model additions. Needs your approval.                          | `pnpm check:repo && pnpm format:check`                            |
| 2   | `withTenant`, the two lint rules, the template-database test harness and `prysm_test_admin` role (F-22)                                                                                                                     | `pnpm --filter @prysm/db test`                                    |
| 3   | Migration 0001: `tenants`, `tenant_settings`, `memberships`, `users` with RLS and grants; coverage test; **generic isolation suite** (F-12)                                                                                 | `pnpm db:migrate && pnpm --filter @prysm/db test`                 |
| 4   | `packages/crypto`: KMS interface, local adapter, envelope and field encryption, `tenant_keys` (F-13, F-15)                                                                                                                  | `pnpm --filter @prysm/crypto test`                                |
| 5   | API foundations: zod type provider, problem+json, idempotency, headers, OpenAPI generation with drift check, route-validation lint (F-18, F-19 api, F-21). **Adds `oasdiff` and Spectral as CI tools: need your approval.** | `pnpm --filter @prysm/api test && pnpm openapi:check`             |
| 6   | Passwords, sessions, signup/login/logout, lockout, CSRF, `admin_audit_log`, `auth_events`, offline breached-password list, `MailSender` + dev-only Mailpit compose service                                                  | `pnpm --filter @prysm/api test`                                   |
| 7   | TOTP enrol/verify, recovery codes, `mfa_pending` gating                                                                                                                                                                     | `pnpm --filter @prysm/api test`                                   |
| 8   | RBAC matrix, `applications`, tenant settings, separation-of-duties primitive                                                                                                                                                | `pnpm --filter @prysm/api test`                                   |
| 9   | API keys: create, rotate, revoke, authenticate; API cross-tenant tests                                                                                                                                                      | `pnpm --filter @prysm/api test`                                   |
| 10  | Web shell + CSP: Next middleware with nonce, secure headers, `/api/v1` proxy, layout, session-aware shell (F-19 web)                                                                                                        | `pnpm --filter @prysm/web test`                                   |
| 11  | Web screens: sign up, log in, MFA enrol/challenge, applications, API keys, logout                                                                                                                                           | `pnpm --filter @prysm/web test && pnpm --filter @prysm/web build` |
| 12  | E2E: Playwright flows against the real stack and axe checks on every screen (F-23)                                                                                                                                          | `pnpm e2e`                                                        |
| 13  | M1 gate: `scripts/verify-m1.mjs`, CI job for the cross-tenant suite and e2e, runbook, TRACKING rows flipped with linked tests, threat-model revision                                                                        | `pnpm verify:m1`, then a green CI run                             |

Deferred follow-ups (not in the 13): WebAuthn, OIDC SSO, invitations, tenant switcher UI.

TRACKING rows flip to `[x]` only in the PR that lands the proving test, each linked.

**TODO registry:** AuditLog entries are not yet written to the evidence chain because the Evidence Vault is M2. That gets `TODO(T-001)` in code and a row in TRACKING §4, targeting M2.

## 12. New dependencies and external services (CLAUDE.md: ask first)

Nothing below has been added to the repo. Versions are the newest release at least 7 days old on 2026-10-15 (the repo's `minimumReleaseAge`). Data from the npm registry; "install script" means a `preinstall`/`install`/`postinstall` entry in the package's own manifest. Full detail and the strictDepBuilds test are in the PR 1 description and ADR-0012's dependency section.

| Package                     | Version | Released   | Licence     | Maintainers (npm) | Install script | Needed by PR | Notes                                                                                            |
| --------------------------- | ------- | ---------- | ----------- | ----------------- | -------------- | ------------ | ------------------------------------------------------------------------------------------------ |
| `@node-rs/argon2`           | 2.2.2   | 2026-10-06 | MIT         | 1                 | none           | 6            | Prebuilt per-platform optional packages (13). Installed under `strictDepBuilds`, see below.      |
| `otpauth`                   | 9.5.2   | 2026-09-03 | MIT         | 1                 | none           | 7            | TOTP/HOTP; 1 dependency.                                                                         |
| `@fastify/cookie`           | 11.1.2  | 2026-07-15 | MIT         | 18 (Fastify org)  | none           | 6            |                                                                                                  |
| `@fastify/helmet`           | 13.1.1  | 2026-08-19 | MIT         | 7 (Fastify org)   | none           | 5            |                                                                                                  |
| `@fastify/rate-limit`       | 11.2.0  | 2026-07-29 | MIT         | 18 (Fastify org)  | none           | 6            | Store: Valkey (already present).                                                                 |
| `fastify-type-provider-zod` | 7.0.0   | 2026-06-24 | MIT         | 2                 | none           | 5            | Named in ADR-0002. Peers: `@fastify/swagger >=9.5.1`, `openapi-types ^12.1.3`, `zod >=4.1.5`.    |
| `@fastify/swagger`          | 9.9.1   | 2026-09-30 | MIT         | 8 (Fastify org)   | none           | 5            | OpenAPI generation.                                                                              |
| `@playwright/test`          | 1.64.0  | 2026-10-07 | Apache-2.0  | 5 (Microsoft)     | none           | 12           | Browser binaries are downloaded by `playwright install` in CI, not by package install. Dev only. |
| `@axe-core/playwright`      | 4.13.0  | 2026-08-11 | **MPL-2.0** | 5 (Deque)         | none           | 12           | Dev/test only, never shipped. MPL-2.0 is file-level copyleft: flagged for your decision.         |

Not proposed any more: `testcontainers` (Q6), `@simplewebauthn/*` and `openid-client` (Q1 deferred), HIBP (Q3). Alternative if you reject `@node-rs/argon2`: `argon2` 0.45.1 (MIT, 2026-07-21) has an `install` script (`node-gyp-build`) and would need an `allowBuilds` entry.

**`@node-rs/argon2` under `strictDepBuilds` (tested 2026-10-15):** in a scratch project that uses the repo's `pnpm-workspace.yaml` settings (`strictDepBuilds: true`, `minimumReleaseAge`, `trustPolicy`, `blockExoticSubdeps`) and no `allowBuilds` entry, `pnpm add --save-exact @node-rs/argon2@2.2.2` succeeded with no build-script prompt. It installed the platform package and an Argon2id hash/verify round trip worked on glibc (host) and on musl (`node:24.21.0-alpine3.24` with pnpm 12.6.0, the base image our Dockerfile uses; it resolved `@node-rs/argon2-linux-x64-musl`). Not yet tested: arm64 images.

**Other new things needing approval:**

| Item                           | Kind                            | Notes                                                                                                                             |
| ------------------------------ | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `oasdiff`                      | **New CI tool** (PR 5)          | Breaking-change check on `docs/api/openapi.json` (ADR-0002). Run as a pinned container image. Needs your approval.                |
| Spectral                       | **New CI tool** (PR 5)          | OpenAPI lint (descriptions required, ADR-0002). Run as a pinned container image. Needs your approval.                             |
| Mailpit                        | Dev-only compose service (PR 6) | Approved by you (Q2). Pinned by digest, bound to 127.0.0.1.                                                                       |
| Offline breached-password list | Data file (PR 6)                | Source and licence not yet chosen; target a modest top-N list (a few MB). I will bring candidates and licences before adding any. |
| `prysm_test_admin` role        | Dev/CI database role (PR 2)     | `CREATEDB` for the test harness; dev and CI only (§10).                                                                           |

## 13. Risks

- **We own security-critical code** (sessions, MFA). Mitigation: libraries for all primitives (ADR-0012), the failure-path tests above, and an ASVS L2 mapping.
- **Global tables are outside RLS.** Mitigation: the allowlist test, narrow grants, and no tenant data in them.
- **Timing and enumeration leaks** on login and key lookup. Mitigation: dummy hashing and tests that compare response shapes.
- **Local Docker on this machine can't stop running containers** (see §10). The harness avoids container control, so this no longer affects tests. It still blocks `infra:down` and `stack:up` rebuilds until the daemon is fixed.
- **Template database cloning needs no open connections to the template**, and `CREATEDB` for the test role. Mitigation: the template is never connected to except by migration and by `CREATE DATABASE`.
- **Schedule risk:** the UI plus Playwright is the largest unknown. PRs 10 to 13 stay last so everything before them is useful on its own.

## 14. Decisions (owner, 2026-10-15) and what is still pending

| Q   | Decision                                                                                                                |
| --- | ----------------------------------------------------------------------------------------------------------------------- |
| Q1  | OIDC and WebAuthn deferred to follow-ups                                                                                |
| Q2  | `MailSender` interface + dev-only Mailpit compose service, approved                                                     |
| Q3  | Offline breached-password list, modest size, no HIBP                                                                    |
| Q4  | **Pending.** Package details in §12. Waiting for your approval                                                          |
| Q5  | `packages/crypto` yes; `authz` inside `core-types`; CLAUDE.md layout updated in PR 1                                    |
| Q6  | One harness for local and CI, per-suite database from a template; no Testcontainers; wording change pending             |
| Q7  | **Pending.** ADR-0012 drafted as Proposed                                                                               |
| Q8  | 30 min idle, 12 h absolute                                                                                              |
| Q9  | MFA mandatory for every account                                                                                         |
| Q10 | Embed the tenant in the key; lookup by key id inside `withTenant`; constant-time hash compare; never `SECURITY DEFINER` |
| Q11 | One tenant per user in the UI for now; schema allows many                                                               |
| Q12 | Invitations later                                                                                                       |
