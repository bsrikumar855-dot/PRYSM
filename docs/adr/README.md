# Architecture Decision Records

Format: Context → Decision → Consequences → Alternatives. Status is one of `Proposed`, `Accepted`, `Superseded by ADR-N`. Changing an Accepted ADR takes a new ADR that supersedes it.

| # | Title | Status |
|---|---|---|
| [0001](0001-monorepo-tooling.md) | Monorepo tooling | Accepted |
| [0002](0002-api-framework.md) | API framework and contract | Accepted |
| [0003](0003-orm-and-migrations.md) | ORM and migrations | Accepted |
| [0004](0004-job-system.md) | Job system (BullMQ vs Temporal) | Accepted |
| [0005](0005-policy-language.md) | Policy language (CEL-based DSL) | Accepted |
| [0006](0006-evidence-canonicalization-and-signing.md) | Evidence canonicalization, chaining and signing | Accepted |
| [0007](0007-multi-tenancy.md) | Multi-tenancy strategy | Accepted |
| [0008](0008-gateway-streaming.md) | Gateway streaming strategy | Accepted |
| [0009](0009-redis-compatible-store.md) | Redis-compatible store, licensing, strict durability via Postgres outbox (amends 0004) | Accepted |
| [0010](0010-llm-providers-and-data-use.md) | LLM providers and data-use requirements | Accepted |
| [0011](0011-object-storage.md) | Object storage: cloud-native Object Lock for SaaS, SeaweedFS for dev/self-hosted, conformance test | Accepted |

Supporting material: [`bench/waitaof-bench.mjs`](bench/waitaof-bench.mjs), [`bench/outbox-bench.mjs`](bench/outbox-bench.mjs) (ADR-0009 measurements).

To be written when the milestone that needs them starts: identity provider build-vs-embed (M1), document parsing stack (M6), collector plugin contract (M8), PDF rendering (M9).
