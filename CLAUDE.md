# PRYSM — agent context

PRYSM is a continuous AI compliance operating system: it turns AI rules (laws, standards, customer policy documents) into versioned controls, enforces them inline on every model call through a gateway, and keeps a tamper-evident evidence trail that auditors can verify offline. It is a production multi-tenant SaaS with a self-hosted edition, built from the same codebase.

**Status:** M0 (Foundations) is in review. ADR-0001..0011 are _Accepted_. Post a plan and get owner approval before starting each milestone.

## Owner decisions that shape day-to-day work

- **No dedicated benchmark runner, no AWS account, no preview environments.** Everything must run fully locally. The gateway benchmark gate is blocking nightly and non-blocking on PRs.
- **PRYSM's own LLM:** provider-agnostic adapter. Initial providers are Google Gemini API and Ollama, plus any OpenAI-compatible local endpoint (vLLM). Every deterministic feature must work with no LLM configured. LLM-dependent features are shown as unavailable, never silently skipped.
- **LLM findings:** at or above threshold → `pending_confirmation` only, excluded from control-status scores until a human confirms. Never passes or closes a control.
- **Regulatory content:** owner-supplied facts (e.g. EU AI Act Omnibus dates) are recorded as unverified until checked against the official source (EUR-Lex, RBI, SEBI, MeitY). ISO 42001 ships clause IDs only.
- **Storage** sits behind the `ObjectStore` interface. SaaS uses cloud-native Object Lock. SeaweedFS is for dev, CI and self-hosted only. Any store must pass `infra/objectstore-conformance/conformance.sh` (ADR-0011).
- **Redis-compatible store:** Valkey is the reference engine. Use only the Redis ≥ 7.2 command set. **Never use `WAITAOF`.** Valkey returns early under `everysec`, and correct implementations take about 1 s. Strict durability uses the Postgres outbox (ADR-0009).
- **No paid or managed services are approved.** Everything runs locally until the M4 purchase decision.
- **LLM data use:** customer data only goes to no-training tiers (paid Gemini API / verified Vertex AI). Never the free tier (ADR-0010).

## Read first

- `docs/ARCHITECTURE.md` — services, data flows, trust boundaries
- `docs/adr/` — decisions. Do not deviate from an _Accepted_ ADR without asking.
- `docs/TRACKING.md` — requirement → milestone map, the TODO registry, deferrals
- `docs/security/THREAT_MODEL.md`

## Non-negotiable principles (short form)

1. **The LLM never has the final say.** LLMs draft, suggest and flag. Deterministic rules or humans decide. Every LLM result stores its confidence, rationale, model and prompt-template version. Results below the threshold go to human review.
2. **No uncited rule.** Every obligation and proposed mapping cites document + version + page + character offsets. The quoted text must match the source exactly (checked by code). No citation means it cannot be approved.
3. **Evidence is immutable.** Append-only, hash-chained, anchored with signatures, object-locked. Nothing in the app can update or delete evidence. Retention expiry is the only removal path, and each expiry is itself logged as evidence.
4. **Tenant isolation is absolute.** Postgres RLS _and_ app-layer checks. Any cross-tenant read is a P0.
5. **The gateway hot path is fast and deterministic.** p95 ≤ 30 ms added at 500 RPS/node for deterministic checks. Slow and LLM checks run async unless a control requires blocking. Fail-open or fail-closed is set per app and always logged.
6. **Privacy by default.** Payload retention is `full | redacted | metadata`. Sensitive fields are encrypted with per-tenant keys.
7. **Not legal advice.** Say "control status" and "evidence of". Never say "compliant". CI enforces this wording rule.
8. **No silent stubs.** Every TODO has an ID in `docs/TRACKING.md` (`TODO(T-123)`). No mock data in production paths.
9. **Never invent regulation text.** Framework content comes from source documents with URL and retrieval date. When unsure, leave it unmapped and flag it.

## Layout

```
apps/        web (Next.js) · api (Fastify) · gateway (Fastify+undici) · workers (BullMQ) · ai-service (Python/FastAPI) · verifier-cli (Go)
packages/    core-types · policy-engine (pure) · detectors · db (Drizzle + SQL/RLS) · evidence · sdk-js · ui
sdks/python  customer SDK
content/     frameworks/ and sector-packs/ — data, not code
infra/       docker/ · helm/ · terraform/
docs/        ARCHITECTURE.md · adr/ · security/ · runbooks/ · api/ · TRACKING.md
```

## Commands

```
corepack enable && pnpm install     # Node 24 LTS, pnpm 12 (hash-pinned). uv sync --all-packages for Python
cp .env.example .env                # dev-only connection strings for the local stack
pnpm infra:up                       # postgres+pgvector, valkey, seaweedfs (+ Object Lock bucket), otel-lgtm
pnpm db:migrate                     # migrations as prysm_owner
pnpm dev                            # all services with hot reload (TS runs from source on Node 24)
pnpm verify:m0                      # readiness, trace in Tempo, logs in Loki, no payload leak
pnpm check                          # format, wording + TODO checks, lint, typecheck, tests (needs infra:up)
pnpm stack:up / pnpm stack:down     # everything in containers (one-command path)
pnpm --filter @prysm/<pkg> test     # one package; Python: cd apps/ai-service && uv run pytest
```

Ports (127.0.0.1 only): api 4000 · gateway 4100 · workers 4200 · web 3001 · ai-service 8000 · Grafana 3000 · Postgres 5432 · Valkey 6379 · S3 8333. See docs/runbooks/local-dev.md.

## Conventions

- TypeScript `strict: true`. Any use of `any` needs an inline justification. Validate every trust boundary with zod.
- Python 3.12 (pinned via uv), ruff, mypy strict, pydantic at boundaries.
- Conventional commits. Small PR-sized changes. Branch → PR → CI green → merge to `main`.
- Migrations are forward-only. Schema changes use expand/contract. RLS policies are hand-written SQL migrations.
- Every tenant-scoped table has `tenant_id`, composite FKs `(tenant_id, id)`, and `ENABLE` + `FORCE ROW LEVEL SECURITY`. A CI check enforces this.
- Logs are structured JSON with `tenant_id` and `request_id`. **Never log raw prompts, responses, payloads or secrets.**
- Files are UTF-8 (no BOM) with LF line endings, enforced by `.editorconfig` + `.gitattributes`. **Never edit files with PowerShell `Get-Content`/`Set-Content` or `-replace`:** Windows PowerShell 5.1 reads BOM-less UTF-8 as ANSI and corrupts non-ASCII text. Use the Edit/Write tools, or `sed` in Git Bash.
- Document every public function (TSDoc / docstring). Inside function bodies, only comment the non-obvious why.
- Policy engine, detectors and evidence code are pure and deterministic: no I/O, no `Date.now()`, no randomness inside them. Pass time and nonces in as inputs.

## Ask before

Adding an external service or paid dependency · changing a principle · changing the domain chain (Framework/PolicyDoc → Obligation → Control → Policy → Evaluation → Finding → Remediation) · deviating from an Accepted ADR · pushing, opening PRs, or anything else visible outside this machine.

## Never

Commit secrets · disable or skip tests to get green · weaken RLS or grant BYPASSRLS to app roles · log raw payloads · fabricate regulation text or citations · mark a requirement done without a test proving it.

## Definition of done (every milestone)

PR merged with CI green (lint, types, tests, security scans, benchmarks where relevant) · tests cover the happy path, failure paths and tenant isolation · docs, ADRs, runbooks and TRACKING updated · runs locally with one command and has a verification script · no untracked TODOs, stubs or mock data.
