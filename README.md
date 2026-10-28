# PRYSM

A continuous AI governance operating system: it turns AI rules into versioned controls, enforces them inline on every model call, and keeps tamper-evident evidence that auditors can verify offline.

## The problem

Teams ship LLM features faster than their policies can keep up. AI rules live in laws, standards and customer policy documents. Enforcement lives in people's heads. Nobody can later show an auditor what a model was allowed to do, what it actually did, and that the record has not been changed.

PRYSM closes that gap. It reads the rules, maps each one to a control with an exact citation, checks every model call against those controls through a gateway, and records the result as evidence that cannot be quietly edited.

## The six components

| Component          | What it does                                                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| **Gateway**        | OpenAI- and Anthropic-compatible proxy. Runs detectors and deterministic policy inline, including on streamed output.         |
| **API / Web**      | REST `/v1`, auth, RBAC and the customer console and auditor portal.                                                           |
| **Workers**        | Evidence ingest, scheduled drift checks, collectors, document pipelines, reports and anchoring.                               |
| **AI service**     | Python service for document parsing, obligation extraction, mapping proposals and LLM-judge calls. It has no database access. |
| **Evidence Vault** | Append-only, hash-chained records, signed anchors and object-locked payloads.                                                 |
| **Verifier CLI**   | Go binary that checks an audit pack offline: chain, Merkle proofs and signatures.                                             |

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for services, data flows and trust boundaries.

## Principles

1. **The LLM never has the final say.** LLMs draft, suggest and flag. Deterministic rules or humans decide. A finding from an LLM waits for human confirmation and never passes or closes a control.
2. **Citations are required.** Every obligation and mapping cites document, version, page and character offsets. The quoted text must match the source exactly, and code checks it.
3. **Evidence is immutable.** Append-only, hash-chained, signed and object-locked. Nothing in the app can update or delete it. Retention expiry is the only removal path, and each expiry is itself logged.
4. **Tenant isolation is absolute.** Postgres row-level security plus application-layer checks. Any cross-tenant read is treated as a P0.

The full list is in [CLAUDE.md](CLAUDE.md).

PRYSM reports **control status** and **evidence of** controls operating. It does not give legal advice and does not certify that anyone meets a law or standard. CI enforces this wording.

## Status

| Milestone | Scope                                            | Status                                                                                                                                   |
| --------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| M0        | Foundations: monorepo, services, local stack, CI | Merged to `main`. All 7 CI jobs green on `main` ([run 38678172559](https://github.com/bsrikumar855-dot/PRYSM/actions/runs/38678172559)). |
| M1        | Identity and tenancy                             | Plan in review. Not started.                                                                                                             |
| M2        | Evidence Vault                                   | Not started                                                                                                                              |
| M3        | Policy engine and detectors                      | Not started                                                                                                                              |
| M4        | AI Gateway                                       | Not started                                                                                                                              |
| M5        | Assets, findings and remediation                 | Not started                                                                                                                              |
| M6        | Rule Intelligence                                | Not started                                                                                                                              |
| M7        | Framework and sector content                     | Not started                                                                                                                              |
| M8 / M8b  | Collectors                                       | Not started                                                                                                                              |
| M9        | Console, reporting, auditor portal               | Not started                                                                                                                              |
| M10       | SDKs and integrations                            | Not started                                                                                                                              |
| M11       | Self-hosted and hardening                        | Not started                                                                                                                              |
| M12       | Launch readiness                                 | Not started                                                                                                                              |

Requirement-level status lives in [docs/TRACKING.md](docs/TRACKING.md).

## Local quickstart

Needs Node 24 LTS (see `.nvmrc`), pnpm 12 via Corepack, uv 0.12.5 or newer, and Docker with Compose v2. Everything runs locally.

```bash
corepack enable && pnpm install     # pnpm 12, hash-pinned
uv sync --all-packages              # Python workspace
cp .env.example .env                # dev-only connection strings for the local stack
pnpm infra:up                       # postgres+pgvector, valkey, seaweedfs (+ Object Lock bucket), otel-lgtm
pnpm db:migrate                     # migrations as prysm_owner
pnpm db:template                    # migrate prysm_template, the clone source for integration-test databases
pnpm dev                            # all services with hot reload
pnpm verify:m0                      # readiness, trace in Tempo, logs in Loki, no payload leak
pnpm check                          # format, wording + TODO checks, lint, typecheck, tests (needs infra:up)
```

`pnpm stack:up` and `pnpm stack:down` run everything in containers. Ports, URLs and troubleshooting are in [docs/runbooks/local-dev.md](docs/runbooks/local-dev.md).

## Demo (hackathon slice, DEMO-ONLY)

A two-day slice under [`demo/`](demo/README.md): redaction, a deterministic policy that decides model tool requests
(never the model), human approvals, and a hash-chained evidence log with an external anchor you can tamper with on purpose
to watch verification fail. Replay mode needs no API key.

```bash
pnpm demo:start                                  # Postgres + migrate + seed + dashboard at http://127.0.0.1:4300
pnpm demo:agent -- --auto-approve demo-script    # in a second terminal: three scenarios
```

The full 3-minute script, replay-mode notes and the list of cut corners are in [`demo/README.md`](demo/README.md).

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Architecture decision records](docs/adr/README.md) (ADR-0001 to ADR-0011)
- [Threat model](docs/security/THREAT_MODEL.md)
- [Tracking: requirements, milestones, deferrals](docs/TRACKING.md)
- [Local development runbook](docs/runbooks/local-dev.md)
- [Agent and contributor rules](CLAUDE.md)

## Licence and trademarks

The code is licensed under [Apache-2.0](LICENSE) (see [NOTICE](NOTICE)). The PRYSM name and logo are not licensed for use in derived products or services; see [TRADEMARKS.md](TRADEMARKS.md).
