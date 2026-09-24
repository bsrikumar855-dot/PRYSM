# PRYSM Tracking

Source of truth for scope, the milestone mapping, deferrals, and every TODO in code.
Status: `[ ]` not started · `[~]` in progress · `[x]` done (**only with a linked test**) · `[→Mn]` deferred to milestone n.

Rules: a requirement is marked `[x]` only once the PR links the test that proves it. Every `TODO` in code must read `TODO(T-###)` and appear in §4. Moves between milestones are recorded in §3.

## 1. Milestones

| # | Milestone | Gate (demo) | Status |
|---|---|---|---|
| — | 9.1 Architecture baseline | CLAUDE.md, ARCHITECTURE, ADR-0001..0008, threat model v1, this file | Approved 2026-09-24, PR open |
| M0 | Foundations | `pnpm i && docker compose up && pnpm dev` → all services report healthy, and the trace is visible in Grafana. CI green with every gate | [ ] |
| M1 | Identity & tenancy | Sign up → MFA → create app → API key. Cross-tenant test suite passes | [ ] |
| M2 | Evidence Vault | Append 100k records → anchor → export pack → `prysm-verify` passes. A tampered pack fails | [ ] |
| M3 | Policy engine + detectors | Compile, evaluate and simulate policies from YAML. Detector corpus meets precision/recall thresholds | [ ] |
| M4 | AI Gateway | OpenAI + Anthropic SDKs work against the gateway with streaming and redaction. The benchmark gate passes | [ ] |
| M5 | Assets + findings/remediation | A violation opens a finding → fix → re-check → finding closes on a pass | [ ] |
| M6 | Rule Intelligence | Upload a policy PDF → cited obligations → mapping proposals → review → publish. Eval harness in CI | [ ] |
| M7 | Framework & sector content | Frameworks and the Indian fintech pack load as data with sources. Coverage view works | [ ] |
| M8 | Collectors I | GitHub + AWS collectors produce evidence. The plugin interface is documented | [ ] |
| M8b | Collectors II | GCP, Azure, Jira, Linear collectors | [ ] |
| M9 | Console, reporting, auditor portal | Dashboards; an audit pack (PDF + bundle) verifies; auditor session is logged | [ ] |
| M10 | SDKs & integrations | JS/Py SDKs published (dry run), log ingestion, Slack/Teams | [ ] |
| M11 | Self-hosted & hardening | Helm install on kind/k3d from docs; backup/restore drill; load + chaos; ASVS L2 checklist | [ ] |
| M12 | Launch readiness | Metering, onboarding, docs site, SLOs and alerts live | [ ] |

## 2. Requirements → milestone

### 2.1 Foundations & cross-cutting (§4, §7)
| ID | Requirement | M | Status |
|---|---|---|---|
| F-01 | pnpm + Turborepo monorepo, uv workspace, Go module, shared configs (ADR-0001) | M0 | [ ] |
| F-02 | Docker Compose dev env: Postgres 16 + pgvector, Redis (AOF, noeviction), MinIO with object lock, OTel/LGTM | M0 | [ ] |
| F-03 | Service skeletons with `/healthz` (liveness) and `/readyz` (readiness), zod-validated config, graceful shutdown | M0 | [ ] |
| F-04 | OpenTelemetry traces/metrics/logs in every service; JSON logs with `tenant_id` + `request_id`; payload-free log test | M0 | [ ] |
| F-05 | CI: lint, typecheck, test, build (TS/Py/Go) | M0 | [ ] |
| F-06 | CI security: gitleaks, OSV/dependency review, Semgrep SAST, Trivy container scan, SBOM (CycloneDX) | M0 | [ ] |
| F-07 | CI: migration check job (ADR-0003) | M0 (job) / M1 (first real schema) | [ ] |
| F-08 | Signed container images (cosign keyless via GitHub OIDC) | M0 | [ ] |
| F-09 | Changesets semver + changelogs; conventional-commit lint | M0 | [ ] |
| F-10 | Wording check: no "compliant/compliance certified" claims in UI, reports, docs (allowlist) | M0 | [ ] |
| F-11 | Preview environments per PR | Deferred, no hosting yet (owner 2026-09-24). Everything must run fully locally | [ ] |
| F-12 | Postgres RLS on every tenant table + coverage test + generic isolation test (ADR-0007) | M1 | [ ] |
| F-13 | Envelope encryption: per-tenant DEK, KMS adapter interface, local KMS adapter | M1 | [ ] |
| F-14 | Cloud KMS adapters (AWS first; GCP/Azure) | M11 | [ ] |
| F-15 | Field-level encryption for sensitive columns (collector creds, upstream keys, PII fields) | M1 | [ ] |
| F-16 | Idempotent jobs, retries with backoff, DLQ + replay tool (ADR-0004) | M2 | [ ] |
| F-17 | Provider-agnostic LLM adapter for PRYSM's own AI, logging model/template version/input hash/output. Initial providers: Google Gemini API + Ollama / OpenAI-compatible local (vLLM) | M6 | [ ] |
| F-17a | LLM-off mode: all deterministic features work with no LLM; LLM-dependent features marked unavailable (tested) | M6 | [ ] |
| F-17b | **Hard requirement:** only no-training provider tiers (paid Gemini API / verified Vertex AI). Provider registry with `data_use_tier` attestation, startup refusal, BYO-key Owner attestation, quarterly terms-review runbook (ADR-0010) | M6 | [ ] |
| F-17d | Attestation audit entry + evidence record: who (user, role, tenant/platform, session, MFA), when (UTC), which key (`SHA-256("prysm.keyfp.v1\n" ‖ key)` fingerprint, never the raw key), provider, project ID, tier, terms URL + date; invalidated on key rotation or terms change (ADR-0010) | M6 | [ ] |
| F-17c | Verify Vertex AI data-governance terms and record them in ADR-0010 before enabling the Vertex adapter | M6 | [ ] |
| F-18 | Public REST API OpenAPI 3.1, generated + committed + drift/breaking check (ADR-0002) | M1 | [ ] |
| F-19 | CSP + secure headers (api, web) | M1 | [ ] |
| F-20 | SSRF-safe egress client shared by collectors and URL fetch | M6 | [ ] |
| F-21 | Input validation at every boundary (zod/pydantic), with a lint rule against unvalidated route handlers | M0 | [ ] |
| F-22 | Integration tests with Testcontainers (Postgres, Redis, MinIO) | M1 | [ ] |
| F-23 | Playwright e2e + axe accessibility checks on critical flows | M1 (first UI) → M9 | [ ] |
| F-24 | WCAG 2.1 AA audit of console | M9 | [ ] |
| F-25 | API p95 < 300 ms standard reads (perf test in CI) | M9 | [ ] |
| F-26 | Gateway availability SLO 99.9% with alerting | M12 | [ ] |
| F-27 | Terraform (AWS) for a region cell: written + `terraform validate` in CI; applied once an AWS account exists | M11 | [ ] |
| F-28 | Helm chart + self-hosted Docker Compose | M11 | [ ] |
| F-29 | Backup/restore with a tested drill | M11 | [ ] |
| F-30 | Load and chaos testing (gateway, ingest, workers) | M11 | [ ] |
| F-31 | ASVS L2 checklist + pen-test readiness checklist | M11 | [ ] |
| F-32 | Global tenant directory (login domain → region) for data residency | M12 | [ ] |
| F-33 | **Pre-M0:** verify MinIO's current licensing/distribution. If usable community images are gone, propose an alternative with S3 Object Lock COMPLIANCE support + ADR. Storage behind `ObjectStore` interface either way | M0 (first task) | [ ] |
| F-34 | `.editorconfig` (utf-8, lf, final newline) + `.gitattributes` (`* text=auto eol=lf`), corepack-managed pnpm, uv-pinned Python 3.12 | M0 | [ ] |
| F-35 | Valkey as the reference Redis-compatible engine; code limited to the Redis ≥ 7.2 command set; boot-time store config checks per role (ADR-0009) | M0 (compose) / M2 (checks) | [ ] |
| F-36 | Pre-merge: WAITAOF (Valkey everysec/always, Redis 8.2 everysec) + Postgres outbox benchmarks run and recorded in ADR-0009 (`docs/adr/bench/*.mjs`) | 9.1 | [x] |
| F-37 | SaaS managed stores: preferred option MemoryDB (streams + BullMQ) + ElastiCache Valkey (rate limits, cache, pub/sub). **No paid service approved; purchase decision at M4.** Confirm MemoryDB ack semantics + failover test before buying. Everything local until then | M4 (decision) | [ ] |
| F-38 | Report the Valkey `WAITAOF`-under-`everysec` early-return bug upstream (ref redis/redis#13793). Draft with standalone repro: `docs/upstream/valkey-waitaof.md`. **Owner files it** | — | [~] drafted |

### 2.2 Identity & tenancy (§4 Auth, §6.9)
| ID | Requirement | M | Status |
|---|---|---|---|
| I-01 | Tenants, users, memberships | M1 | [ ] |
| I-02 | Email + password (Argon2id) + MFA (TOTP, WebAuthn) | M1 | [ ] |
| I-03 | OIDC SSO | M1 | [ ] |
| I-04 | SAML SSO (established library, no embedded IdP) | M11 | [ ] |
| I-05 | SCIM provisioning | M11 | [ ] |
| I-06 | RBAC: Owner, Admin, Compliance Manager, Engineer, Reviewer, Auditor (read-only), with an exhaustive permission-matrix test | M1 | [ ] |
| I-07 | Scoped API keys (gateway/SDK/collector/ingest), hashed, rotatable | M1 | [ ] |
| I-08 | PRYSM admin AuditLog (append-only) | M1 | [ ] |
| I-09 | Tenant settings: retention mode + period, data residency region, SSO config | M1 | [ ] |
| I-10 | Key management UI/API (rotate DEK, view signing key fingerprints) | M11 | [ ] |
| I-11 | Separation of duties: authors can't approve their own changes | M1 (primitive) / M6 | [ ] |

### 2.3 Evidence Vault (§6.6)
| ID | Requirement | M | Status |
|---|---|---|---|
| E-01 | RFC 8785 JCS → SHA-256 → per-tenant gapless hash chain, single writer (ADR-0006) | M2 | [ ] |
| E-02 | Merkle anchoring, Ed25519-signed roots, key rotation | M2 | [ ] |
| E-03 | Off-platform anchor delivery (customer webhook / bucket / email digest); ≥1 destination mandatory for production tenants; PRYSM-managed default in a separate account | M2 | [ ] |
| E-04a | `TimestampAuthority` adapter interface; verifier handles optional `tsr/` | M2 | [ ] |
| E-04b | Real RFC 3161 TSA integration (TSA choice = external service, ask first) | M11 | [ ] |
| E-05 | Payloads client-side encrypted in object-locked (COMPLIANCE) storage; metadata + hashes in Postgres | M2 | [ ] |
| E-06 | DB immutability: write-only grants + trigger; tested | M2 | [ ] |
| E-07 | `verifier-cli` (Go) offline verification + shared test vectors incl. mutation cases | M2 | [ ] |
| E-08 | Per-tenant retention; expiry job; `retention.expired` evidence | M2 | [ ] |
| E-09 | Audit bundle format (machine-readable) + export | M2 (format) / M9 (UI, PDF) | [ ] |
| E-10 | Crypto-shredding on tenant offboarding + runbook | M11 | [ ] |
| E-11 | Key rotation runbook (signing + DEKs) | M2 | [ ] |
| E-12 | Per-tenant strict durability via Postgres transactional outbox: `strict_outbox` + RLS, `prysm_gateway_outbox` INSERT-only role, dedicated pool, `synchronous_commit=on`; `request.started` committed before upstream, `request.completed` before terminal chunk; shard ingest worker appends + deletes in one transaction; budget ≤ 50 ms p95 TTFB / ≤ 20 ms terminal chunk; separate nightly bench scenario (ADR-0009) | M4 (M2: table + relay) | [ ] |
| E-13 | Optional Sigstore Rekor anchor destination (opaque digests only), inclusion proofs verified offline by `verifier-cli`. `AnchorDestination` interface in M2 | M11 | [ ] |

### 2.4 Policy Engine & Detectors (§6.4, §6.3 detectors)
| ID | Requirement | M | Status |
|---|---|---|---|
| P-01 | Policy YAML schema + CEL, compile with type-check, content-hashed artifact (ADR-0005) | M3 | [ ] |
| P-02 | Pure deterministic evaluator shared by gateway, workers, api; property tests for determinism | M3 | [ ] |
| P-03 | Action precedence + decision trace | M3 | [ ] |
| P-04 | Simulation function (draft vs published over inputs) | M3 | [ ] |
| P-05 | Simulation over the last N days of real events via API/UI | M5 | [ ] |
| P-06 | LLM-judged tier: async, confidence-gated, rationale + model/template version, review routing. At/above threshold → Finding `pending_confirmation` only; never passes/closes a control; excluded from scores until human confirms | M6 | [ ] |
| P-07 | Scheduled drift checks: framework + gateway-derived checks (approved models only, logging on, retention set) | M5 | [ ] |
| P-08 | Drift checks backed by collectors (cloud config) | M8 | [ ] |
| P-09 | Controls versioned, change approval, permanent history | M3 | [ ] |
| P-10 | Policy/control publish API + `policy.published` hot-reload signal | M3 | [ ] |
| D-01 | Indian identifiers: PAN, Aadhaar (Verhoeff), IFSC, UPI ID, Indian phone, GSTIN (checksum) | M3 | [ ] |
| D-02 | Global PII: email, phone (E.164), payment cards (Luhn), IBAN, IP, names/addresses (heuristic, flagged lower confidence) | M3 | [ ] |
| D-03 | Secrets: cloud keys, private keys, JWTs, high-entropy tokens | M3 | [ ] |
| D-04 | Prompt-injection heuristics | M3 | [ ] |
| D-05 | Normalization (NFKC, zero-width stripping) + adversarial corpus; precision/recall thresholds in CI | M3 | [ ] |
| D-06 | Linear-time guarantees: regex fuzzing; RE2 for customer patterns; declared max span per detector | M3 | [ ] |
| D-07 | Forbidden-content categories (deterministic lexicons + async LLM classifier) | M4 (lexicon) / M6 (LLM) | [ ] |

### 2.5 AI Gateway (§6.3)
| ID | Requirement | M | Status |
|---|---|---|---|
| G-01 | OpenAI-compatible: Chat Completions, Responses, Embeddings, Models, incl. streaming | M4 | [ ] |
| G-02 | Anthropic-compatible: Messages (+ count_tokens) incl. streaming | M4 | [ ] |
| G-02a | Image/audio content metadata-only in v1 (recorded, not inspected) | M4 | [ ] |
| G-02b | Upstream credentials: stored-encrypted (default, tenant DEK) and pass-through (never logged/persisted, canary test) | M4 | [ ] |
| G-03 | Inspection modes passthrough / holdback / buffered; chunking-invariance property tests (ADR-0008) | M4 | [ ] |
| G-04 | Pre-request: PII/secrets detect + redact, injection heuristics, model allowlist, required disclosures | M4 | [ ] |
| G-05 | Per-app / per-user rate limits and budgets (tokens, cost) | M4 | [ ] |
| G-06 | Post-response: PII leakage, forbidden content, policy detectors; block/replace/annotate/allow | M4 | [ ] |
| G-07 | Async GatewayEvent emission (Redis Streams), disk spool, backpressure, gap records | M4 | [ ] |
| G-08 | Payload retention modes full / redacted / metadata | M4 | [ ] |
| G-09 | Fail-open/fail-closed per app, always evidenced | M4 | [ ] |
| G-10 | Health checks, stateless horizontal scaling, graceful stream drain | M4 | [ ] |
| G-11 | Zero-downtime policy hot reload | M4 | [ ] |
| G-12 | Contract tests against recorded real provider responses | M4 | [ ] |
| G-13 | Benchmark suite committed; gate p95 added ≤ 30 ms @ 500 RPS/node — blocking nightly + non-blocking PR check until a dedicated runner exists | M4 | [ ] |
| G-14 | Usage counters for metering (events, monitored apps) | M4 (capture) / M12 (billing export) | [ ] |
| G-15 | Connection pooler (PgBouncer in transaction mode, or equivalent) in front of Postgres for the gateway's `strict_outbox` pool. Documented max-connections calculation, per the runbook: (1) **per gateway node** client pool = ⌈strict_RPS_per_node × 2 commits/request × p95_commit_latency_s × 1.5 headroom⌉ (Little's law); (2) **PgBouncer** `max_client_conn` ≥ Σ over gateway nodes of (1) at max autoscale; `default_pool_size` (server conns for the outbox role) = ⌈total strict_RPS × 2 × p95_commit_latency_s × 1.5⌉; (3) **Postgres** `max_connections` ≥ Σ PgBouncer server pools + api + workers + migrations + `superuser_reserved_connections`. A load test proves no pool exhaustion at 500 RPS/node | M4 | [ ] |

### 2.6 Assets, Findings, Remediation, Review (§5, §6.7)
| ID | Requirement | M | Status |
|---|---|---|---|
| A-01 | Application + AIAsset registry (model, prompt, dataset, agent, tool); controls scoped to assets/apps | M5 | [ ] |
| A-02 | Evaluations linked to controls, policies, events, evidence | M5 | [ ] |
| A-03 | Findings from failed evaluations with context (asset, control, event, deploy/commit) | M5 | [ ] |
| A-04 | Dedup + grouping, severity, SLA timers, owners, comments | M5 | [ ] |
| A-05 | Remediation tasks; auto re-evaluation; close only on a passing check | M5 | [ ] |
| A-06 | Human review queue (LLM results, proposed mappings) | M5 (queue) / M6 (mapping + judge items) | [ ] |
| A-07 | Reviewer agreement metrics | M6 | [ ] |
| A-08 | Notifications: email + signed webhooks | M5 | [ ] |
| A-09 | Notifications: Slack, Microsoft Teams | M10 | [ ] |
| A-10 | Deploy/commit linkage for findings | M8 (GitHub collector) | [ ] |

### 2.7 Rule Intelligence (§6.1)
| ID | Requirement | M | Status |
|---|---|---|---|
| R-01 | Parse PDF/DOCX/HTML/MD with layout; page numbers + char offsets (sandboxed, permissive licences only) | M6 | [ ] |
| R-02 | Segment obligations; classify applies-to, obligation type, risk tier | M6 | [ ] |
| R-03 | Hybrid retrieval (pgvector + lexical) + rerank for mapping proposals | M6 | [ ] |
| R-04 | Citation spans + confidence on every proposal; mechanical span validation | M6 | [ ] |
| R-05 | Review workflow: source ↔ control diff, approve/reject/edit, full history | M6 | [ ] |
| R-06 | Document versioning: detect affected obligations/controls, open review items | M6 | [ ] |
| R-07 | Eval harness + golden dataset (extraction P/R, mapping accuracy) with CI thresholds | M6 | [ ] |
| R-08 | Tenant controls for PRYSM's LLM use (provider choice, no-external-LLM mode) | M6 | [ ] |

### 2.8 Control Library & Content (§3, §6.2)
| ID | Requirement | M | Status |
|---|---|---|---|
| C-01 | Framework model: framework → version → obligations, as data under `content/` with source URL + retrieval date | M7 | [ ] |
| C-02 | EU AI Act incl. Digital Omnibus timeline. Owner-supplied, **unverified by us**: Omnibus = Reg. (EU) 2026/1744, in force 2026-07-27; Annex III high-risk → 2027-12-02; Annex I → 2028-08-02; Art. 50 from 2026-08-02; watermarking for systems already on market → 2026-12-02. Verify every date against EUR-Lex at M7 before loading | M7 | [ ] |
| C-03 | ISO/IEC 42001: clause IDs only in `content/`; clause text loaded per tenant from the customer's licensed copy | M7 | [ ] |
| C-04 | NIST AI RMF 1.0 (+ GenAI profile) | M7 | [ ] |
| C-05 | India DPDP Act 2023 + DPDP Rules 2025 (official notified text, source + retrieval date) | M7 | [ ] |
| C-06 | Indian fintech sector pack. Candidate sources — fetch official current versions, confirm in-force/superseded, **report back to owner before loading**: RBI FREE-AI framework report (2025); RBI MD on IT Governance, Risk, Controls & Assurance Practices (2023); RBI MD on Outsourcing of IT Services (2023); RBI Digital Lending Directions (latest); SEBI circulars on AI/ML usage reporting by intermediaries; SEBI guidelines/consultation on responsible AI/ML in securities markets (2025); SEBI CSCRF | M7 | [ ] |
| C-07 | Sector pack format: pluggable bundle of controls + detectors + policies | M7 | [ ] |
| C-08 | OSCAL-compatible JSON import/export | M7 | [ ] |
| C-09 | Framework coverage view: mapped / unmapped / partial | M7 (API) / M9 (UI) | [ ] |
| C-10 | Customer policy documents as first-class sources (the wedge) | M6 | [ ] |

### 2.9 Collectors (§6.5)
| ID | Requirement | M | Status |
|---|---|---|---|
| K-01 | Collector plugin interface; isolated packages with their own tests | M8 | [ ] |
| K-02 | GitHub (prompt/model/config changes, PR reviews, CI eval results) | M8 | [ ] |
| K-03 | AWS (encryption, IAM, logging) | M8 | [ ] |
| K-04 | GCP | M8b | [ ] |
| K-05 | Azure | M8b | [ ] |
| K-06 | Jira, Linear | M8b | [ ] |
| K-07 | Encrypted credentials; least-privilege scopes documented per collector | M8 | [ ] |

### 2.10 Reporting & Auditor Portal (§6.8)
| ID | Requirement | M | Status |
|---|---|---|---|
| RP-01 | Live dashboards: control status per framework/policy, trends, top failing controls, gateway stats, on pre-aggregated tables | M9 | [ ] |
| RP-02 | Audit packs: PDF + evidence bundle + verification instructions, any period/scope | M9 | [ ] |
| RP-03 | Auditor portal: time-boxed, read-only, scoped; every action logged | M9 | [ ] |

### 2.11 SDKs & Integrations (§3, §6.9)
| ID | Requirement | M | Status |
|---|---|---|---|
| S-01 | JS/TS SDK (types generated from OpenAPI) | M10 | [ ] |
| S-02 | Python SDK | M10 | [ ] |
| S-03 | Bulk log ingestion (for teams that can't proxy), evaluated by the same engine | M10 | [ ] |
| S-04 | Outbound signed webhooks (HMAC, timestamped, retries) | M5 | [ ] |

### 2.12 Launch (§6.9, §7)
| ID | Requirement | M | Status |
|---|---|---|---|
| L-01 | Usage metering (monitored apps, gateway events), exportable | M12 | [ ] |
| L-02 | Payment provider integration | Post-M12 (per brief) | [ ] |
| L-03 | Onboarding flow (incl. mandatory anchor destination with managed default) | M12 | [ ] |
| L-04 | Docs site: API reference, self-hosting guide, customer integration guide | M10 (integration) / M11 (self-host) / M12 (site) | [ ] |
| L-05 | Runbooks: incident, key rotation, restore from backup, tenant offboarding | M2 (key rotation) / M11 / M12 | [ ] |
| L-06 | SLOs + alerting live | M12 | [ ] |

## 3. Scope changes log
| Date | Change | Approved by |
|---|---|---|
| 2026-09-24 | SAML + SCIM moved M1 → M11 | Owner |
| 2026-09-24 | Collectors split: M8 = GitHub + AWS; new M8b = GCP, Azure, Jira, Linear | Owner |
| 2026-09-24 | RFC 3161: interface in M2, real TSA integration M11 | Owner |
| 2026-09-24 | Preview environments deferred (no hosting); benchmark gate nightly-blocking / PR-non-blocking (no dedicated runner) | Owner |
| 2026-09-24 | No AWS account yet: Terraform validated, not applied | Owner |
| 2026-09-24 | PRYSM LLM providers: Gemini API + Ollama/OpenAI-compatible local; LLM-off mode required | Owner |
| 2026-09-24 | Per-tenant strict durability (WAITAOF) added (E-12) | Owner |
| 2026-09-24 | Strict durability: Postgres transactional outbox chosen over a second `always` Valkey (measured: p95 16.4 vs 32.7 ms at 50 conns). No WAITAOF anywhere (ADR-0009) | Owner |
| 2026-09-24 | Valkey chosen as the reference engine (ADR-0009) | Owner |
| 2026-09-24 | Managed SaaS stores: preferred option recorded, purchase deferred to M4 (F-37) | Owner |
| 2026-09-24 | LLM data-use hard requirement + attestation audit fields (ADR-0010) | Owner |
| 2026-09-24 | Optional Rekor anchor destination (E-13, M11) | Owner |

## 3a. Open questions (decide at the named milestone)

| ID | Question | Decide at | How | Status |
|---|---|---|---|---|
| OQ-1 | Should **all** tenants' evidence events use the Postgres outbox (one path) instead of Redis Streams + outbox (two paths)? | M4 | Benchmark at realistic scale (target gateway fleet at 500 RPS/node, mixed tenant sizes) on the reference runner. Criteria: **throughput per Postgres node** (incl. WAL volume, autovacuum, replica lag), **cost** (IOPS/instance size vs a managed Redis-compatible store), **operational simplicity** (components, failure modes, runbooks), **hash-chain ordering complexity** (one source per shard vs merging stream + outbox in the single writer). Record the outcome in a new ADR that amends ADR-0004/0009 | Open |

## 4. TODO registry
Every `TODO(T-###)` in the codebase must appear here. CI fails on a `TODO` that has no ID or isn't registered.

| ID | Location | Description | Milestone |
|---|---|---|---|
| — | — | none | — |
