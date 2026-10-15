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

| Need                                          | Primitive                                                                                                                                      | Implementation                                                                                       |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Password hashing                              | **Argon2id** (RFC 9106). Parameters and salt stored per hash (separate columns); OWASP minimum as the floor, tuned up on the reference machine | `node:crypto` `argon2` (proposed) or `@node-rs/argon2`. **Owner decision pending**, see Dependencies |
| MFA codes                                     | **TOTP** (RFC 6238) over HOTP (RFC 4226); SHA-1, 6 digits, 30 s step, **current step only (window 0)**; replay protection by last-used step    | `otpauth`                                                                                            |
| Random values                                 | OS CSPRNG, at least 128 bits for anything non-guessable                                                                                        | `node:crypto` `randomBytes`                                                                          |
| Session tokens                                | 256-bit **opaque random** reference token; only its SHA-256 is stored                                                                          | `node:crypto`                                                                                        |
| API key secrets                               | 256-bit opaque random; stored as `SHA-256(domain ‖ key)`                                                                                       | `node:crypto`                                                                                        |
| Recovery codes, reset and verification tokens | 128-bit random, single use, short expiry for tokens; stored as SHA-256 (at least 112 bits, so no password hash is needed)                      | `node:crypto`                                                                                        |
| Constant-time compare                         | `timingSafeEqual`                                                                                                                              | `node:crypto`                                                                                        |
| Field and DEK encryption                      | **AES-256-GCM** (NIST SP 800-38D) with AAD binding; per-tenant DEK wrapped by a KMS adapter                                                    | `node:crypto` (package `packages/crypto`)                                                            |
| Cookies                                       | `__Host-` prefixed, `HttpOnly; Secure; SameSite=Lax; Path=/`                                                                                   | `@fastify/cookie`                                                                                    |
| Headers, rate limits                          | Standard secure headers; backoff limits in Valkey                                                                                              | `@fastify/helmet`, `@fastify/rate-limit`                                                             |
| Errors                                        | RFC 9457 `application/problem+json`                                                                                                            | `fastify-type-provider-zod` (ADR-0002)                                                               |

### Explicitly NOT built

- **No custom cryptography.** No home-made cipher, mode, KDF, hash, MAC, nonce scheme or key-wrap format. AES-256-GCM and Argon2id come from a vetted implementation. Our code only chooses parameters, supplies AAD and stores outputs.
- **No custom token formats.**
  - Sessions are opaque random strings. There are **no JWTs, no signed or encrypted cookies**, and no self-describing claims.
  - The server trusts nothing it parses out of a token. Every token is looked up by its hash.
- **The single exception is the API key layout** `prysm_<tenant>_<key_id>_<secret>` (owner-approved 2026-10-15 with conditions). It is a fixed `prysm_` prefix plus three opaque identifiers, with no claims, signature or checksum. Conditions:
  1. The fixed `prysm_` prefix stays, so secret scanners can find leaked keys.
  2. The `<tenant>` part is **untrusted input until the hash compare succeeds.** It is used only to choose which tenant scope to look in.
  3. Lookup order is fixed: split the key, then `withTenant(<tenant>)`, then select by `key_id` under RLS, then a **constant-time** compare of the hash. Failure at any step returns the same generic error.
  4. Keys are **never logged**, never placed in URLs or query strings, never written to traces or error bodies. They travel in a header only. Canary tests cover logs, traces and errors.
- No home-grown TOTP, no custom OTP delivery, no SMS or email codes as a second factor.
- No identity provider, OAuth/OIDC server, or SSO in M1. No WebAuthn in M1.
- No composition rules for passwords beyond length and the offline lists.
- No `SECURITY DEFINER` functions and no RLS bypass anywhere in identity code (owner, 2026-10-15).
- No secrets in logs, traces or error bodies; the existing canary tests are extended to cover them.

### Data and flow in brief

- Global tables (no RLS, allowlisted and tested, see ADR-0013): `users`, `user_mfa_factors`, `mfa_recovery_codes`, `sessions`, `auth_events`. Tenant tables follow ADR-0007, including `memberships`, `api_keys`, `admin_audit_log`.
- A new session is `mfa_pending` and may call only MFA enrol/verify. MFA is mandatory for every account. **Password reset never bypasses MFA.** A lost second factor is recovered only with a recovery code or an Owner-initiated, audited reset.
- Sessions: 30 min idle, 12 h absolute, rotated on login, MFA success, tenant change and privilege change. Stored in Postgres. Users can list and end their own sessions; admins can end any session in their tenant; disabling an account ends all its sessions; changing a credential offers to end the others.
- Changing the email address or MFA settings requires fresh authentication.
- RBAC: six roles, a permission map in `core-types`, and an exhaustive role × permission test.

## ASVS Level 2 mapping

**Version.** `TRACKING.md` (F-31, M11) and `THREAT_MODEL.md` say "ASVS Level 2" and name no version, so nothing binds us to 4.0.3. ASVS **5.0.0** (released 2025-05-30) is the latest numbered release. **Proposal: adopt 5.0.0 L2** (owner to confirm; F-31 and the threat-model header would then name it).

**How this table was checked.** An earlier draft used 4.0.3 numbers from memory. This version was rebuilt from the standard itself: the CSV in the OWASP/ASVS repository at tag `v5.0.0_release` (`5.0/docs_en`, 345 requirements), reading each requirement's text and level flags. Levels below are the CSV flags (`L1` means required from level 1; `L2` from level 2). Short descriptions are paraphrases, not quotations. "Status" says what M1 delivers; anything not "Met" is a gap and appears in the list after the table.

| ASVS 5.0.0             | Level | Requirement (paraphrased)                                                                            | Status in M1 and how                                                                                                                 | PR      | Proof                                             |
| ---------------------- | ----- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------- | ------------------------------------------------- |
| V6.1.1                 | L1    | Document how rate limiting and anti-automation defend credential attacks                             | Met: runbook section, incl. how lockout avoids malicious account lockout                                                             | 6       | doc review + lockout tests                        |
| V6.2.1                 | L1    | Passwords of at least 8 characters (15 strongly recommended)                                         | Met at 12. Open question: raise to 15                                                                                                | 6       | policy tests                                      |
| V6.2.3                 | L1    | Password change needs current and new password                                                       | Met                                                                                                                                  | 6       | change-password test                              |
| V6.2.4                 | L1    | Check against at least the top 3000 passwords                                                        | Met by the offline list                                                                                                              | 6       | rejected-password test                            |
| V6.2.5, V6.2.8         | L1    | No composition rules; password used exactly as typed                                                 | Met                                                                                                                                  | 6       | policy tests (no truncation or case change)       |
| V6.2.9, V6.2.10        | L2    | Allow 64+ characters; no periodic rotation                                                           | Met (max 128)                                                                                                                        | 6       | boundary tests                                    |
| V6.2.12                | L2    | Check against a set of breached passwords                                                            | Met by the offline list                                                                                                              | 6       | known-breached test                               |
| V6.3.1                 | L1    | Credential-stuffing and brute-force controls implemented per documentation                           | Met: per-account and per-source backoff in Valkey, `auth_events`                                                                     | 6       | lockout and recovery tests                        |
| V6.3.3                 | L2    | MFA or equivalent factors required for access                                                        | Met: mandatory TOTP for every account                                                                                                | 7       | `mfa_pending` gating tests                        |
| V6.4.1                 | L1    | Initial/activation codes random and short-lived                                                      | Met (128-bit, single use, short expiry)                                                                                              | 6       | expiry and reuse tests                            |
| V6.4.3                 | L2    | Password reset must not bypass MFA                                                                   | Met by design                                                                                                                        | 6, 7    | reset-then-MFA test                               |
| V6.4.4                 | L2    | Lost MFA factor needs identity proofing equal to enrolment                                           | Met: recovery code, or audited Owner reset only                                                                                      | 7       | recovery path tests                               |
| V6.5.1                 | L2    | TOTP and lookup secrets usable once                                                                  | Met: last-used step, single-use recovery codes                                                                                       | 7       | replay tests                                      |
| V6.5.2                 | L2    | Lookup secrets under 112 bits need a salted password hash                                            | Met: recovery codes are 128 bits, so a standard hash is allowed                                                                      | 7       | code length and format test                       |
| V6.5.3                 | L2    | TOTP seeds and codes from a CSPRNG                                                                   | Met                                                                                                                                  | 7       | unit test on generator                            |
| V6.5.5                 | L2    | TOTP lifetime at most 30 seconds                                                                     | Met only with **window 0** (current step). A ±1 window would give up to 90 s; not used                                               | 7       | window test                                       |
| V7.1.1                 | L2    | Timeouts documented and justified against NIST SP 800-63B                                            | Met in part: 30 min / 12 h chosen. The NIST comparison text is a PR 6 deliverable                                                    | 6       | doc review                                        |
| V7.2.1–V7.2.4          | L1    | Backend verifies sessions; random reference tokens of at least 128 bits; new token at authentication | Met (256-bit opaque tokens, rotated on login)                                                                                        | 6       | token, rotation and fixation tests                |
| V7.3.1, V7.3.2         | L2    | Inactivity timeout and absolute lifetime enforced                                                    | Met                                                                                                                                  | 6       | expiry tests                                      |
| V7.4.1                 | L1    | Logout or expiry invalidates the session                                                             | Met (server-side revoke)                                                                                                             | 6       | logout test                                       |
| V7.4.2                 | L1    | Disabling or deleting an account ends all its sessions                                               | Met                                                                                                                                  | 6       | disable-account test                              |
| V7.4.3                 | L2    | Offer to end other sessions after a credential change                                                | Met                                                                                                                                  | 6, 7    | change-credential test                            |
| V7.4.4, V7.4.5         | L2    | Visible logout; admins can end any user's sessions                                                   | Met                                                                                                                                  | 6, 11   | API test + e2e                                    |
| V7.5.1                 | L2    | Full re-authentication before changing email or MFA settings                                         | Met                                                                                                                                  | 6, 7    | reauth tests                                      |
| V7.5.2                 | L2    | Users can view and end their active sessions                                                         | Met                                                                                                                                  | 6, 11   | API test + e2e                                    |
| V3.3.1–V3.3.4          | L1/L2 | Cookie `Secure`, `SameSite`, `__Host-`, `HttpOnly`                                                   | Met                                                                                                                                  | 6, 10   | header assertions                                 |
| V3.4.1                 | L1    | HSTS on all responses                                                                                | Met at the web/api edge (TLS terminates at the edge in production; dev is HTTP)                                                      | 5, 10   | header test (when TLS configured)                 |
| V3.4.2                 | L1    | CORS allow-origin fixed or validated                                                                 | Met: fixed same origin; no wildcard                                                                                                  | 5       | header test                                       |
| V3.4.3–V3.4.6          | L2    | CSP, nosniff, referrer policy, `frame-ancestors`                                                     | Met: nonce-based CSP on web; helmet on api                                                                                           | 5, 10   | per-route header tests                            |
| V3.5.1                 | L1    | Requests that rely on no CORS preflight must be validated as same-origin (CSRF)                      | Met: `SameSite`, Origin/Sec-Fetch-Site check, double-submit token                                                                    | 6       | CSRF rejection tests                              |
| V8.1.1, V8.2.1, V8.3.1 | L1    | Authorization rules documented; function-level access explicit; enforced server-side                 | Met: permission map, per-route permission, route lint                                                                                | 8       | role × permission matrix                          |
| V8.2.2                 | L1    | Data-specific access prevents IDOR                                                                   | Met: RLS + app scoping + 404 for foreign ids                                                                                         | 3, 9    | generic isolation and API cross-tenant tests      |
| V8.2.3                 | L2    | Field-level access (BOPLA)                                                                           | Met in part: strict response schemas return only allowed fields. Per-field role rules arrive with the data that needs them           | 5, 8    | response-schema tests                             |
| V8.4.1                 | L2    | Cross-tenant controls so one tenant can't affect another                                             | Met: RLS, composite FKs, `withTenant`, isolation suite                                                                               | 2, 3, 9 | generic isolation suite                           |
| V2.2.1, V2.2.2         | L1    | Positive input validation at a trusted layer                                                         | Met: zod `.strict()` on every route; lint rule fails unvalidated routes                                                              | 5       | lint rule tests                                   |
| V15.3.1, V15.3.3       | L1/L2 | Return only needed fields; defend against mass assignment                                            | Met                                                                                                                                  | 5       | mass-assignment tests                             |
| V11.1.1, V11.1.2       | L2    | Key-management policy and a cryptographic inventory                                                  | **Gap to close in PR 4**: add a short key-lifecycle policy and a crypto inventory document                                           | 4       | document exists and is checked by `check:repo`    |
| V11.2.1                | L2    | Use industry-validated crypto implementations                                                        | Met: `node:crypto` and the Argon2 implementation chosen above                                                                        | 4, 6    | review + known-answer tests                       |
| V11.2.2                | L2    | Crypto agility (algorithms and parameters can be changed)                                            | Met: algorithm, parameters and `kek_id`/DEK version stored with each value                                                           | 4       | rotation and rehash tests                         |
| V11.3.1–V11.3.3        | L1/L2 | No ECB or weak padding; approved modes such as AES-GCM; authenticated encryption                     | Met: AES-256-GCM only                                                                                                                | 4       | tamper tests                                      |
| V11.4.1, V11.4.2       | L1/L2 | Approved hashes; passwords stored with an approved password hash                                     | Met: SHA-256, Argon2id                                                                                                               | 4, 6    | format tests                                      |
| V11.5.1                | L2    | Non-guessable values from a CSPRNG with at least 128 bits of entropy                                 | Met: sessions 256, keys 256, recovery/reset 128. Key ids and tenant ids are identifiers, not secrets                                 | 6, 7, 9 | length tests                                      |
| V13.3.1                | L2    | Secrets held in a secrets-management solution / key vault                                            | **Partial**: the local KMS adapter reads a file; cloud KMS adapters (F-14) arrive in M11. Self-hosted must document file permissions | 4       | adapter permission test; gap stays open until M11 |
| V14.2.1                | L1    | Sensitive data never in URLs or query strings                                                        | Met: API keys and tokens only in headers or bodies                                                                                   | 5, 9    | URL canary test                                   |
| V14.3.2                | L2    | `Cache-Control: no-store` for sensitive responses                                                    | Met on auth and key responses                                                                                                        | 5, 6    | header test                                       |
| V16.2.1, V16.2.5       | L2    | Log metadata (who/what/when); sensitive data not logged                                              | Met: structured logs with `tenant_id`/`request_id`; allowlist plus canary scans                                                      | 6       | canary tests                                      |
| V16.3.1, V16.3.2       | L2    | Log authentication operations and failed authorization                                               | Met: `auth_events`, `admin_audit_log`, authorization-failure log lines                                                               | 6, 8    | log assertion tests                               |
| V16.5.1                | L2    | Generic message for unexpected or security-sensitive errors                                          | Met: problem+json with no internals                                                                                                  | 5       | error-body tests                                  |
| V15.1.2                | L2    | Maintain an SBOM of third-party components                                                           | Met in M0: CycloneDX SBOM in CI                                                                                                      | M0      | CI `security` job                                 |
| V1.2.4                 | L1    | Parameterised queries / ORM                                                                          | Met: Drizzle and parameterised `pg`                                                                                                  | 2       | lint rule on raw SQL outside `packages/db`        |

**Not in M1 and tracked:** the L3 items, federated login and OIDC/SAML assertions (V6.8.x, V10, deferred), WebAuthn (deferred), notifications of suspicious sign-ins (V6.3.5, L3), and the full L2 sign-off, which is the M11 checklist (F-31). Rows marked Gap or Partial are repeated in the plan so they are not lost.

**Design changes forced by checking the real text** (all already reflected above; none was in the first draft):

1. TOTP accepts the current step only. V6.5.5 caps TOTP lifetime at 30 s, and a ±1 window would exceed it.
2. Recovery codes are 128-bit and hashed with SHA-256, not 80-bit. V6.5.2 and V11.5.1 only allow a standard hash from 112 bits and ask for 128.
3. Password reset must not bypass MFA (V6.4.3), and a lost factor needs identity proofing (V6.4.4).
4. Session management gains list-and-end-sessions, admin termination, end-on-disable, end-others-after-credential-change and re-authentication for sensitive changes (V7.4.x, V7.5.x). These add scope to PRs 6, 7 and 11.
5. A key-management policy and a crypto inventory document are needed (V11.1.1, V11.1.2).
6. V13.3.1 (secrets in a key vault) is only partly met until cloud KMS arrives in M11.

## Dependencies

Packages this ADR relies on are listed with versions, release dates, licences and install-script status in the M1 plan, §12. Owner decisions on 2026-10-15:

- Approved: `otpauth`, `@fastify/cookie`, `@fastify/helmet`, `@fastify/rate-limit`, `fastify-type-provider-zod`, `@fastify/swagger`, `@playwright/test`, and `@axe-core/playwright` (MPL-2.0, dev only).
- **Password hashing library: decision pending.** `node:crypto` `argon2` and `argon2Sync` exist on the pinned Node 24.21.0 (added in v24.7.0). In the Node v24.21.0 docs source they carry no per-API stability marker and sit under the crypto module's "Stability: 2 - Stable". A hash/verify round trip and the RFC 9106 test vector passed on 24.21.0. Dropping `@node-rs/argon2` removes a native third-party package; what we would then write ourselves is salt generation, storing parameters in columns and a `timingSafeEqual` check (no PHC string parser, because parameters go in columns). The plan recommends dropping it.

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
