# ADR-0012: Identity and authentication

Status: **Proposed** · 2026-10-15. Not Accepted. No M1 code starts until the owner marks this Accepted.

## Context

M1 needs sign-up, passwords, MFA, sessions, RBAC and API keys on top of the tenancy model in ADR-0007. The ADR index has reserved this decision as "identity provider build-vs-embed (M1)". Constraints that shape it:

- Tenant isolation is absolute (principle 4). Identity data has to fit RLS, composite foreign keys and the audit log.
- Everything runs locally and self-hosted; no paid or managed service is approved (CLAUDE.md).
- Security-critical code that we write ourselves is a liability, so the design should be mostly glue between vetted primitives.
- OIDC and WebAuthn are deferred past the M1 gate (owner, 2026-10-15). SAML and SCIM are M11.

## Decision

**Build a thin identity layer in-house, on vetted primitives.** We write the data model, the flows and the authorization checks. We write none of the cryptography and define no token formats beyond one identifier layout (below).

### Primitives we use

| Need                     | Primitive                                                                                                     | Implementation                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Password hashing         | **Argon2id** (RFC 9106), parameters stored with each hash; OWASP minimum as the floor, tuned to about 100 ms  | `@node-rs/argon2` (prebuilt Rust bindings) |
| MFA codes                | **TOTP** (RFC 6238) over HOTP (RFC 4226); SHA-1, 6 digits, 30 s, ±1 step; replay protection by last-used step | `otpauth`                                  |
| Random values            | OS CSPRNG                                                                                                     | `node:crypto` `randomBytes`                |
| Session tokens           | 256-bit **opaque random** token; only its SHA-256 is stored                                                   | `node:crypto`                              |
| API key secrets          | 256-bit opaque random; stored as `SHA-256(domain ‖ key)`                                                      | `node:crypto`                              |
| Recovery codes           | high-entropy random; stored as SHA-256                                                                        | `node:crypto`                              |
| Constant-time compare    | `timingSafeEqual`                                                                                             | `node:crypto`                              |
| Field and DEK encryption | **AES-256-GCM** (NIST SP 800-38D) with AAD binding; per-tenant DEK wrapped by a KMS adapter                   | `node:crypto` (package `packages/crypto`)  |
| Cookies                  | `__Host-` prefixed, `HttpOnly; Secure; SameSite=Lax; Path=/`                                                  | `@fastify/cookie`                          |
| Headers, rate limits     | Standard secure headers; fixed-window and backoff limits in Valkey                                            | `@fastify/helmet`, `@fastify/rate-limit`   |
| Errors                   | RFC 9457 `application/problem+json`                                                                           | `fastify-type-provider-zod` (ADR-0002)     |

### Explicitly NOT built

- **No custom cryptography.** No home-made cipher, mode, KDF, hash, MAC, nonce scheme or key-wrap format. AES-256-GCM and Argon2id come from the platform library and the Rust crate. Our code only chooses parameters, supplies AAD and stores outputs.
- **No custom token formats.**
  - Sessions are opaque random strings. There are **no JWTs, no signed or encrypted cookies**, and no self-describing claims.
  - The server trusts nothing it parses out of a token. Every token is looked up by its hash.
- **The single exception is the API key layout** `prysm_<tenant>_<key_id>_<secret>`, a prefix plus three opaque identifiers. It carries no claims, no signature and no checksum. It exists so the tenant is known before the database lookup (ADR-0007: `withTenant` first) and so secret scanners can recognise leaks. The tenant part is trusted only after the hash compare succeeds. The owner should confirm this exception.
- No home-grown TOTP, no custom OTP delivery, no SMS or email codes as a second factor.
- No identity provider, OAuth/OIDC server, or SSO in M1. No WebAuthn in M1.
- No password-strength meter logic or composition rules beyond length and the offline breached list.
- No `SECURITY DEFINER` functions and no RLS bypass anywhere in identity code (owner, 2026-10-15).
- No secrets in logs, traces or error bodies; the existing canary tests are extended to cover them.

### Data and flow in brief

- Global tables (no RLS, allowlisted by test): `users`, `user_mfa_factors`, `mfa_recovery_codes`, `sessions`, `auth_events`. Tenant tables follow ADR-0007, including `memberships`, `api_keys`, `admin_audit_log`. The global-table exception is ADR-0013.
- A new session is `mfa_pending` and may call only MFA enrol/verify. It becomes usable after MFA. MFA is mandatory for every account.
- Sessions: 30 min idle, 12 h absolute, rotated on login, MFA success, tenant change and privilege change. Stored in Postgres.
- API keys: lookup by key id inside `withTenant(<tenant from key>)`, then a constant-time hash compare.
- RBAC: six roles, a permission map in `core-types`, and an exhaustive role × permission test.

## ASVS Level 2 mapping

Numbers refer to **OWASP ASVS 4.0.3** and are my reading of each item. Before acceptance they should be re-checked against the standard text, and re-mapped if the project adopts ASVS 5.0. "PR" is the plan PR that implements it. "Test" is the proof that must exist before the TRACKING row flips.

| ASVS           | Requirement (short)                                        | How M1 meets it                                                            | PR    | Test                                         |
| -------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------- | ----- | -------------------------------------------- |
| V2.1.1         | Passwords at least 12 characters                           | Minimum 12                                                                 | 6     | password policy unit tests                   |
| V2.1.2         | Passwords of 64 characters allowed, over 128 rejected      | Max 128, no truncation                                                     | 6     | boundary tests                               |
| V2.1.7         | Check passwords against a breached list                    | Offline list, modest size                                                  | 6     | known-breached password rejected             |
| V2.1.9         | No composition rules                                       | Length and breach check only                                               | 6     | policy tests                                 |
| V2.2.1         | Anti-automation against credential stuffing                | Per-account and per-source backoff and lockout in Valkey, `auth_events`    | 6     | lockout and recovery tests                   |
| V2.4.1         | Passwords stored with an approved, salted, slow hash       | Argon2id with per-hash salt and stored parameters                          | 6     | hash format and rehash-on-login test         |
| V2.5.x         | Secure credential recovery                                 | Reset via `MailSender` single-use token (hash stored, short expiry)        | 6     | reset flow and replay tests                  |
| V2.8.1, V2.8.4 | Time-based OTP has a limited lifetime and is used once     | TOTP ±1 step, `last_used_step` replay rejection                            | 7     | replayed-code test                           |
| V2.8.x         | OTP uses approved cryptography                             | RFC 6238 via `otpauth`                                                     | 7     | known-answer vectors                         |
| V2.10.x        | Service credentials (API keys) handled safely              | 256-bit secrets, stored hashed, shown once, rotatable and revocable        | 9     | rotate/revoke/replay tests                   |
| V3.2.1         | New session token at authentication                        | Rotated on login and MFA                                                   | 6, 7  | session-fixation test                        |
| V3.2.2         | Session tokens have at least 64 bits of entropy            | 256 bits                                                                   | 6     | token length/entropy test                    |
| V3.3.1, V3.3.2 | Logout invalidates the session; idle and absolute timeouts | Server-side revocation, 30 min and 12 h                                    | 6     | logout, idle and absolute expiry tests       |
| V3.4.1–V3.4.4  | Cookie `Secure`, `HttpOnly`, `SameSite`, `__Host-` prefix  | Set exactly so                                                             | 6, 10 | header assertions                            |
| V4.1.x         | Access control enforced server-side, deny by default       | Principal from session or key only; permission per route                   | 8     | role × permission matrix                     |
| V4.2.1         | Protection against IDOR                                    | RLS + app scoping; 404 for foreign ids                                     | 3, 9  | generic isolation and API cross-tenant tests |
| V4.2.2         | CSRF protection                                            | SameSite, Origin/Sec-Fetch-Site check, double-submit token                 | 6     | CSRF rejection tests                         |
| V4.3.1         | Administrative interfaces use MFA                          | MFA mandatory for all accounts                                             | 7     | `mfa_pending` gating tests                   |
| V5.1.x         | Input validation                                           | zod `.strict()` on every route; route-lint rule fails unvalidated handlers | 5     | lint rule tests; mass-assignment tests       |
| V6.1.1         | Sensitive data encrypted at rest                           | Field encryption for MFA seeds and SSO config                              | 4     | tamper/AAD/round-trip tests                  |
| V6.2.x         | Approved algorithms, no custom crypto, nonces not reused   | AES-256-GCM via `node:crypto`; random 96-bit nonce with per-DEK usage cap  | 4     | known-answer and nonce-limit tests           |
| V6.4.1         | Keys managed through a key-management layer                | `KmsAdapter` with local adapter; cloud adapters M11                        | 4     | adapter contract tests                       |
| V7.1.x         | No credentials or sensitive data in logs                   | Logger allowlist plus canary scans                                         | 6     | canary tests across logs, traces, errors     |
| V8.3.x         | Sensitive data not leaked in responses or caches           | `Cache-Control: no-store` on auth responses; generic errors                | 5, 6  | header and response-shape tests              |
| V13.2.x        | RESTful API: schema validation, CSRF, correct methods      | OpenAPI generated from zod; drift check                                    | 5     | `openapi:check`                              |
| V14.2.1        | Components kept up to date                                 | Dependabot, OSV and Trivy in CI                                            | M0    | CI                                           |
| V14.4.x        | HTTP security headers                                      | Helmet on api; nonce CSP on web                                            | 5, 10 | per-route header tests                       |

Not met in M1 and tracked for later: V2.9 cryptographic authenticators (WebAuthn, deferred), federated login V3.5 (OIDC, deferred), full ASVS L2 sign-off (M11 checklist, F-31).

## Dependencies

New packages this ADR relies on are listed with versions, release dates, licences and install-script status in the M1 plan, §12. `@node-rs/argon2` was installed in a scratch project under the repo's `strictDepBuilds` settings with no `allowBuilds` entry and worked on glibc and on `node:24.21.0-alpine3.24`. `@axe-core/playwright` is MPL-2.0 (dev only) and needs an explicit owner decision. **The owner has not yet approved the package list (Q4).**

## Consequences

- We own the session, MFA and API-key logic. That is the main risk, and it is why the primitives table and the NOT-built list are strict, and why every row in the ASVS table needs a test.
- Identity tables sit outside RLS. This is acceptable only because they hold identity, not tenant data, and ADR-0013 adds the allowlist test that makes it safe.
- Fast SHA-256 for API key secrets is correct only because the secrets are 256-bit random. Nothing a human chooses is ever hashed with it.
- Deferring OIDC and WebAuthn means M1 customers sign in with a password and TOTP only. The session model and `memberships` do not change when those arrive.
- Sessions in Postgres cost an indexed lookup per request. Revisit if the console load makes that visible.

## Alternatives rejected

| Alternative                                            | Why not                                                                                                                                   |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Auth library** (better-auth, Auth.js and similar)    | Brings its own tables, conventions and plugin model that must be bent to RLS, composite FKs and our audit log. Harder to prove isolation. |
| **Self-hosted IdP** (Keycloak, Ory Kratos and similar) | A new stateful service for every deployment, heavy for self-hosted, and a second user model to reconcile with RLS. Needs owner approval.  |
| **Hosted identity** (Auth0, Clerk, WorkOS and similar) | Paid and managed, which is not approved; data-residency and self-hosted editions would not work.                                          |
| **JWT sessions or signed cookies**                     | Cannot be revoked server-side without a lookup anyway; adds a token format and signing-key management we said we would not build.         |
| **Sessions in Valkey**                                 | Valkey runs with `appendfsync everysec`, so recent logins and revocations can be lost; revocation should be auditable.                    |
| **bcrypt, scrypt or PBKDF2**                           | Argon2id is the current OWASP recommendation and memory-hard.                                                                             |
| **`argon2` (node-gyp)**                                | Needs a build script and a toolchain under `strictDepBuilds`; `@node-rs/argon2` ships prebuilt binaries.                                  |
| **SMS or email one-time codes for MFA**                | Phishable and SIM-swappable; need a delivery service.                                                                                     |
| **Hashing API keys with HMAC and a server pepper**     | Stronger against a database-only leak, but adds pepper management and rotation. Kept as an M11 hardening option.                          |
| **Encrypting with libsodium or age**                   | Good tools, but a new dependency for something `node:crypto` does, and we need the AAD binding to table, column and row.                  |
