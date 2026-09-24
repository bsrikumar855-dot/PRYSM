# ADR-0004: Job system

Status: Accepted · 2026-09-24

## Context
There are two very different workloads:
1. **Gateway event ingest.** High volume (500+ events/s per gateway node) and small. It must be durable, and appends must be serialized per tenant for the hash chain (ADR-0006).
2. **Background jobs.** Document pipelines, LLM judges, collectors, scheduled drift checks, anchoring, reports, notifications and retention. These run at low to medium volume, need retries, backoff, schedules and dead-lettering, and are mostly seconds to minutes long.

Self-hosted customers have to run whatever we pick.

## Decision
- **Redis is the only broker.**
- **Event ingest uses Redis Streams directly**, not BullMQ. Stream `events:{shard}` has 64 shards, with `shard = hash(tenant_id) % 64`. A consumer group reads it, with one active consumer per shard, so each tenant's chain has a single writer. Consumers read in batches (≤500 events or 50 ms), then write the S3 payloads, the evidence rows (one transaction per tenant batch), the evaluations and the outbox, and only then `XACK`. Unacked entries get reclaimed via `XAUTOCLAIM`.
- **Background jobs use BullMQ.** Named queues per job type, exponential backoff, and an **idempotency key** for every job (`jobId` = deterministic hash of intent). Scheduled checks are repeatable jobs. After max attempts a job moves to the failed set, which serves as the DLQ: a metric, an alert, and a `prysm-admin jobs replay` command.
- Redis configuration is required and checked at boot: `appendonly yes`, `appendfsync everysec`, `maxmemory-policy noeviction`. Production runs a replica with Sentinel or a managed failover.
- If the gateway can't `XADD`, it appends to a bounded local disk spool, which a background loop drains. Spool full → **fail-closed** apps reject requests, and **fail-open** apps continue while incrementing `events_dropped`. Dropped counts are written as a `gap` evidence record once Redis recovers, so the gap is itself evidenced.
- Postgres is the system of record. Redis only holds work in flight.

## Consequences
- `appendfsync everysec` can lose up to about 1 s of events if Redis crashes before they're persisted. Those events never reach the chain, so this doesn't break tamper-evidence, but it is a completeness gap. Mitigations: a replica, the spool, and gap records. **Accepted as the default (owner, 2026-09-24).**
- **Per-tenant "strict durability" option: see ADR-0009.** The earlier design (`WAITAOF` on the shared `everysec` instance, "1–10 ms") was wrong. On an `everysec` instance, `WAITAOF` waits for the next once-per-second fsync. A correct implementation (Redis 8.2) measured ≈ 1 s per call, and Valkey 8.1 returns early without fsyncing (an upstream bug). Strict tenants' durable events go through a **Postgres transactional outbox** (`synchronous_commit=on`, dedicated INSERT-only pool). The shard's ingest worker moves them into the chain in the same transaction that deletes them. They have their own latency budget outside the 30 ms gateway budget. PRYSM uses no `WAITAOF`.
- The "≤ 1 s" loss window applies to self-hosted Valkey/Redis with AOF `everysec`. ElastiCache doesn't support AOF, so the preferred SaaS option (MemoryDB for streams, with the purchase decision deferred to M4) is covered in ADR-0009.
- The fixed shard count caps per-tenant ingest at one consumer. Batched appends make that thousands of events per second per tenant, which is well above target. Resharding is a documented operation.

## Alternatives
- **Temporal:** excellent for long-running, multi-step workflows. But it needs its own cluster and persistence, which is a heavy lift for self-hosted customers, and our workflows are short. Revisit if we need durable multi-day orchestration beyond "DB state + scheduled re-check".
- **Postgres queues (pg-boss / graphile-worker):** transactional with our writes and no Redis needed. But event ingest at gateway volume would load the primary DB, and we need Redis anyway for rate limits and budgets.
- **Kafka / NATS JetStream:** stronger durability and replay, but another stateful system to run. Revisit if one region's event volume outgrows Redis Streams.
