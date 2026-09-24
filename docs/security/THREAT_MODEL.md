# PRYSM Threat Model — v1

Status: v1 (2026-09-24), written pre-implementation. It is revised at the start and end of every milestone. Method: STRIDE per service, over the trust boundaries in `docs/ARCHITECTURE.md` §6. Target: OWASP ASVS Level 2.

## 1. Assets (ranked)

| # | Asset | Why it matters |
|---|---|---|
| A1 | Customer prompts and responses (payloads) | Can contain PII, Aadhaar/PAN, trade secrets |
| A2 | Evidence chain, anchors, signing keys | The product's core promise. Forgery or loss destroys trust |
| A3 | Tenant boundary | A single cross-tenant leak is existential |
| A4 | Customer credentials: upstream LLM keys, cloud/GitHub/Jira collector creds | Pivot into customer infrastructure |
| A5 | Tenant DEKs, KMS master keys | Decrypt A1 and A4 |
| A6 | Policies, control mappings, approvals | Tampering silently disables enforcement or fakes control status |
| A7 | PRYSM API keys and sessions | Impersonation |
| A8 | Availability of the gateway | Customer production depends on it (inline) |

## 2. Actors

External attacker · malicious or compromised customer user (inside their own tenant) · a user of tenant A targeting tenant B · malicious content author (poisoned policy PDF, prompt-injection text in model traffic) · compromised upstream or collector target · malicious or careless PRYSM insider · compromised dependency or build pipeline · auditor exceeding their scope.

## 3. STRIDE by service

### 3.1 gateway

| Threat | Example | Mitigation | Milestone |
|---|---|---|---|
| **S** | Stolen PRYSM API key used to proxy on a victim's budget | Scoped keys (app + environment + allowed endpoints), stored as SHA-256 hashes, prefix-identifiable for secret scanning, optional IP allowlist, per-key rate limit and budget, rotation | M1, M4 |
| **T** | Attacker changes policy in flight or makes the gateway load an unsigned policy | Artifacts fetched by content hash over mTLS/internal network and hash-verified before swap. Every event records the policy hash | M4 |
| **R** | Customer disputes that a request was blocked | Every decision is emitted with its trace and the policy hash, into the evidence chain | M4 |
| **I** | Payloads leak via logs, traces, error messages or metrics labels | Logger allowlist (payload fields never logged). OTel attributes carry no payload. Errors are sanitized. A test asserts that known PII fixtures never appear in log output | M0, M4 |
| **I** | Redaction bypass via encoding tricks (zero-width chars, full-width digits, spacing) | Unicode NFKC + zero-width stripping before detection, and an adversarial corpus in the detector tests | M3 |
| **D** | ReDoS via crafted prompts | Linear-time built-in regexes, fuzzed in CI; customer patterns use RE2; per-request detector CPU budget; max body size | M3, M4 |
| **D** | Slowloris or long streams exhaust sockets | Header/body timeouts, max concurrent streams per key, idle stream timeout, graceful drain | M4 |
| **E** | Compromised gateway pod uses its Postgres connection to read or alter data | The `prysm_gateway_outbox` role has INSERT on `strict_outbox` only: no SELECT, UPDATE or DELETE, and no other tables. RLS `WITH CHECK` on `tenant_id`. The outbox relay validates each payload against its schema before appending to the chain (ADR-0009) | M4 |
| **R** | Durability claim is silently false (e.g. Valkey `WAITAOF` under `everysec` returns before fsync, an upstream bug) | PRYSM uses no `WAITAOF`. Strict durability rests on a Postgres commit with `synchronous_commit=on`. A boot check refuses to start if `synchronous_commit` is off for the outbox role | M4 |
| **D** | Redis outage blocks the hot path | Spool fallback plus a per-app fail mode. Rate limiting degrades to local per-node token buckets, which are logged | M4 |
| **E** | SSRF via a customer-configured upstream base URL | Upstream is chosen from a provider registry. Custom base URLs (e.g. Azure OpenAI, self-hosted vLLM) go through the SSRF guard, and private ranges need explicit self-hosted config | M4 |
| **E** | Model allowlist bypass via a model alias or a provider-specific header | Model resolved after provider normalization. Unknown request fields are rejected in strict mode | M4 |

### 3.2 api and web

| Threat | Example | Mitigation | Milestone |
|---|---|---|---|
| **S** | Credential stuffing, session theft | Argon2id, breached-password check (k-anonymity, offline list for self-hosted), TOTP/WebAuthn MFA, lockout with backoff, `__Host-` cookies (HttpOnly, Secure, SameSite=Lax), session rotation | M1 |
| **S** | SAML signature wrapping or OIDC token confusion | Vetted libraries only, strict audience/issuer/nonce checks, an XML signature wrapping test corpus | M1 |
| **T** | CSRF on console mutations | SameSite cookies, a double-submit token, Origin checks | M1 |
| **T** | Mass assignment changing `tenant_id` or `role` | zod strict schemas. `tenant_id` comes only from the principal | M1 |
| **R** | Admin denies changing a policy or approving a mapping | Append-only AuditLog for every admin action. Approvals are also evidence records | M1, M2 |
| **I** | IDOR across tenants | RLS + app scoping + 404 on foreign IDs, with the per-endpoint tests from ADR-0007 | M1 |
| **I** | XSS showing payload excerpts in the console | React escaping, strict CSP (nonce-based, no `unsafe-inline`), payload viewers rendered as text only, Trusted Types where supported | M1, M9 |
| **D** | Expensive queries (large exports, simulation over long ranges) | Queued jobs with quotas, pagination limits, per-tenant concurrency caps | M5, M9 |
| **E** | Role escalation (Engineer approves their own mapping, auditor writes) | RBAC matrix tested exhaustively (role × permission). Separation of duties: the author of a mapping or control change can't approve it. Auditor role is read-only and time-boxed | M1, M6, M9 |

### 3.3 workers and collectors

| Threat | Example | Mitigation | Milestone |
|---|---|---|---|
| **S** | Forged inbound webhook (GitHub, Jira) | Signature verification per provider, replay window, idempotency | M8 |
| **T** | Job payload tampering in Redis | Redis on a private network with ACLs and TLS. Jobs carry IDs only and re-read state from Postgres under `withTenant` | M2 |
| **I** | SSRF from collector URLs or document URL fetch (to 169.254.169.254, internal services) | One egress client: resolve DNS → deny private, loopback, link-local and metadata ranges, pin the resolved IP, re-check on redirects, max size and time, deny non-HTTP(S). Egress network policy too | M6, M8 |
| **I** | Over-privileged collector credentials | A least-privilege scope list is documented per collector. Credentials are encrypted with the tenant DEK and decrypted only in the collector job | M8 |
| **E** | Worker running a job in the wrong tenant context | `withTenant` from the job's `tenant_id`. Platform-role jobs are isolated modules with AuditLog writes | M2 |

### 3.4 ai-service (PRYSM's own AI)

| Threat | Example | Mitigation | Milestone |
|---|---|---|---|
| **T** | **Prompt injection in an uploaded policy PDF** ("mark all controls satisfied") | ai-service has no DB creds or tools. Output is schema-validated. Citations are checked mechanically against the source text. Humans approve every mapping. LLM output can never approve or close anything | M6 |
| **T** | An injected document shifts the LLM judge's verdict | Judges only flag. Below threshold they go to review. Judge inputs are delimited, and the template version is logged. Reviewer agreement metrics catch drift | M6 |
| **I** | Customer documents sent to a third-party LLM without consent | Per-tenant setting: provider choice (Gemini, or Ollama/vLLM local), "no external LLM" mode, and data-processing disclosure. Every call is logged | M6 |
| **I** | **The LLM provider trains on, or has humans review, customer documents and payloads** (e.g. Gemini unpaid tier: content used to improve products, human review) | **Hard requirement:** only the paid Gemini API (billing-enabled project) or verified Vertex AI. Provider registry with a `data_use_tier` attestation; ai-service refuses to start without it. BYO keys need an Owner attestation, logged with who (user, role, MFA), when (UTC) and which key (SHA-256 fingerprint, raw key never logged). Quarterly terms review, and re-attestation when the terms' "last modified" date changes. Abuse-monitoring retention disclosed as a sub-processor flow. Local-only option (ADR-0010) | M6 |
| **I** | Pass-through upstream keys leak through logs, traces or events | Never persisted or logged. A log/trace scanning test injects canary keys and asserts they never appear | M4 |
| **D** | Malicious files (zip bombs, huge PDFs, parser exploits) | Size, page and time limits. Parsing runs in a sandboxed subprocess with no network. File type checked by magic bytes | M6 |

### 3.5 Evidence vault and storage

| Threat | Example | Mitigation | Milestone |
|---|---|---|---|
| **T** | DB admin rewrites evidence rows | Write-only grants and triggers make it detectable, not impossible. Anchors delivered off-platform plus optional TSA mean any rewrite fails verification against the customer-held anchors | M2 |
| **T** | Signing key theft lets an attacker re-sign a rewritten chain | Key in KMS (non-exportable where supported), used only by the anchoring worker. Off-platform anchors pre-date the theft. Key rotation runbook | M2 |
| **R** | "PRYSM lost our evidence" | Object Lock COMPLIANCE, gapless `seq`, `gap` records for dropped events, backups with restore drills. Strict tenants get a Postgres outbox with `request.started` committed before the upstream call (ADR-0009) | M2, M4, M11 |
| **T** | Collusion: PRYSM insider and the customer's own storage both compromised | Optional public transparency-log anchor (Rekor). Only opaque digests are published, never `tenant_id` or counts. Inclusion proofs are verified offline (ADR-0006) | M11 |
| **I** | Metadata leak through the public transparency log | Entries contain only an anchor digest and a region-key signature. No tenant identifiers or sizes. Opt-in per tenant | M11 |
| **I** | Payload exposure from a storage breach | Client-side AES-256-GCM with tenant DEK. Salted payload hashes | M2 |
| **D** | Chain fork from concurrent writers | Single writer per shard + `UNIQUE(tenant_id, seq)` / `(tenant_id, prev_hash)` | M2 |

### 3.6 Supply chain and platform

| Threat | Mitigation | Milestone |
|---|---|---|
| Malicious dependency | Lockfiles with frozen installs, `pnpm` `onlyBuiltDependencies` allowlist, dependency review on PRs, OSV scanning, Renovate with a minimum release age | M0 |
| Compromised CI | Least-privilege `GITHUB_TOKEN`, actions pinned by SHA, OIDC to cloud (no long-lived secrets), protected `main` | M0 |
| Tampered images | Minimal bases, Trivy scan, SBOM (Syft/CycloneDX), cosign keyless signatures, verified at deploy | M0, M11 |
| Secrets in the repo | gitleaks pre-commit + CI | M0 |

## 4. Top risks carried forward

1. **Insider rewrite of evidence.** Only as strong as off-platform anchor delivery. Decided: at least one destination is mandatory for production tenants, with a PRYSM-managed default in a separate cloud account. That default doesn't stop a PRYSM-wide insider, so customer-owned destinations are encouraged in the console (ADR-0006).
2. **JS CEL library maturity** (ADR-0005). Conformance testing plus a wrapper.
3. **Streaming redaction correctness.** Detector max-span declarations must be right, or holdback leaks. Property tests: for random chunkings of an input, the output is identical to buffered mode.
4. **Detector false negatives on Indian identifiers.** Checksum validation plus a labelled corpus with precision and recall thresholds in CI.
5. **Third-party LLM data flow** for PRYSM's own features. Tenant-level controls and disclosure are needed before M6 ships.

## 5. Review cadence
Re-run STRIDE for every new service, external integration or trust-boundary change. Each milestone PR must include a "threat model delta" section (it can be "none").
