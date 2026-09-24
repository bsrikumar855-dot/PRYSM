# ADR-0009: Redis-compatible store, licensing, and strict durability

Status: Proposed · 2026-09-24. Amends ADR-0004 (strict durability section).

## Context
ADR-0004 uses a Redis-compatible store for event streams, BullMQ, rate limits and pub/sub. The owner asked for three things: a licensing comparison of Redis and Valkey for the self-hosted edition, a check of which managed services support AOF and `WAITAOF`, and measured `WAITAOF` latency.

## Findings (checked 2026-09-24)

### Licensing
| Engine | Licence | WAITAOF |
|---|---|---|
| Redis ≥ 8.0 | Tri-licence, chosen by the user: RSALv2, SSPLv1, or AGPLv3 (since 8.0, May 2025). [redis.io/legal/licenses](https://redis.io/legal/licenses/) | Yes (since 7.2) |
| Redis 7.4–7.x | RSALv2 / SSPLv1 only (not OSI open source) | Yes |
| Valkey | BSD-3-Clause (Linux Foundation fork of Redis 7.2.4) | Yes: "Introduced in 7.2.0" ([valkey.io/commands/waitaof](https://valkey.io/commands/waitaof/)) |

### WAITAOF semantics under `appendfsync everysec` (from Valkey source, `src/aof.c` and `src/server.c`, `unstable` branch)
- The fsync is timer-driven only: `server.aof_fsync == AOF_FSYNC_EVERYSEC && server.mstime - server.aof_last_fsync >= 1000` → `aof_background_fsync(...)`. Nothing forces an fsync because a client is blocked in `WAITAOF`.
- `beforeSleep` only *wakes* blocked clients early once `fsynced_reploff` advances (`dont_sleep = 1`).
- **So on an `everysec` instance, `WAITAOF 1 0` waits for the next once-per-second background fsync: 0–1000 ms, uniformly distributed, plus the fsync time. Expected p50 ≈ 500 ms, p95 ≈ 950 ms.** The earlier "1–10 ms" estimate in ADR-0004 was wrong for this configuration.
- Under `appendfsync always`, the AOF is written and fsynced in `beforeSleep` before replies are flushed. The `XADD` reply therefore already implies durability, and `WAITAOF 1 0` returns immediately.

### Measured
Reproduce with `docs/adr/bench/waitaof-bench.mjs` (the header lists the exact `docker run` lines). Scenarios: `XADD` alone, and `XADD` + `WAITAOF 1 0` with 1 and 50 connections, 512-byte payload.

| Engine | appendfsync | Scenario | p50 | p95 | p99 | ops/s |
|---|---|---|---|---|---|---|
| Valkey 8 | everysec | XADD only | _pending_ | | | |
| Valkey 8 | everysec | XADD + WAITAOF, 1 conn | _pending_ | | | |
| Valkey 8 | everysec | XADD + WAITAOF, 50 conns | _pending_ | | | |
| Valkey 8 | always | XADD only | _pending_ | | | |
| Valkey 8 | always | XADD + WAITAOF, 50 conns | _pending_ | | | |

_Pending:_ Docker Desktop on the dev machine fails at startup (stale `sailor-ingest.sock`). The numbers will be filled in from a real run before this ADR is accepted. Desktop WSL2 disk timings are **not** representative of production disks, so the M4 nightly benchmark re-measures on the reference runner.

### Managed services
| Service | AOF / fsync control | WAITAOF | Suitable for strict events |
|---|---|---|---|
| AWS ElastiCache (Valkey / Redis OSS) | `appendonly` / `appendfsync` are not supported on Redis OSS 2.8.22 and later. Multi-AZ and AOF are mutually exclusive, and AWS recommends Multi-AZ ([Redis AOF docs](https://docs.aws.amazon.com/AmazonElastiCache/latest/red-ug/RedisAOF.html)). `CONFIG` is a restricted command | Not in the supported-commands list; `WAIT` is restricted on serverless ([supported commands](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/SupportedCommands.html)) | **No.** The loss window is async replication lag on failover, not "≤ 1 s AOF" |
| AWS MemoryDB | No AOF. A multi-AZ transaction log; "Only data that is successfully persisted in the multi-AZ transaction log is visible". Single-digit-ms writes ([MemoryDB FAQ](https://aws.amazon.com/memorydb/faqs/)). `CONFIG` restricted ([restricted commands](https://docs.aws.amazon.com/memorydb/latest/devguide/restrictedcommands.html)) | Not needed: every write is durable. `numlocal=1` is not applicable without AOF | **Yes, for every tenant.** The exact ack point (commit before reply) must be confirmed with an AWS doc/support answer and a failover test in M4 |
| Google Memorystore for Valkey | AOF with `always` / `everysec` (default) / `no` ([docs](https://docs.cloud.google.com/memorystore/docs/valkey/about-aof-persistence)) | Not documented | Yes with `always`, pending a WAITAOF check |
| Upstash Redis | Persistence always on (block storage) ([durability](https://upstash.com/docs/redis/features/durability)) | Not documented | Not planned (per-request model, unverified fsync semantics) |
| Azure Managed Redis | AOF persistence available ([docs](https://learn.microsoft.com/en-us/azure/redis/how-to-persistence)) | Not documented | Unverified; revisit if we target Azure |

## Decision
1. **Valkey is the reference engine** for local dev, CI, the Helm chart and the Compose bundle, because BSD-3 keeps the self-hosted edition free of copyleft or source-available terms that enterprise legal teams often block. The code targets the Redis ≥ 7.2 command set only (no Valkey-only or Redis-8-only commands), so customers may bring Redis 7.2+ under whatever licence they accept. PRYSM does not redistribute Redis. BullMQ lists Valkey as supported ([bullmq.io](https://bullmq.io/)), and CI's Testcontainers integration tests run against Valkey.
2. **Strict durability does not use WAITAOF on an `everysec` instance** (0–1000 ms). Instead, events for strict tenants go to a **durable stream store**:
   - **Self-hosted / local:** a second Valkey instance with `appendfsync always` (or a single `always` instance if the customer wants every tenant strict). The gateway writes to it on a **dedicated connection pool**, because `WAITAOF` covers every earlier write on its connection and blocks it. After `XADD` it issues `WAITAOF 1 0 <timeout>` as a cheap assertion, which returns immediately under `always` and errors if AOF has been disabled. A failed assertion counts as an enforcement failure, handled by the app's fail mode.
   - **SaaS (AWS):** proposed: **MemoryDB for all event streams and BullMQ** (durable for every tenant, so SaaS has no strict/standard split), and **ElastiCache for Valkey** for rate limits, caches and pub/sub, where losing a counter on failover is acceptable. MemoryDB and a second AWS service are **new paid dependencies, so this needs owner approval** before M4.
3. **Strict mode request flow:** a durable `request.started` event is written *before* the upstream call, and a durable `request.completed` event before the terminal chunk (`[DONE]` / `message_stop`) is released. A gateway crash mid-stream therefore always leaves evidence that the request started. Under concurrency, `always` fsyncs once per event-loop iteration for every client, which amortizes the cost.
4. **Budgets:** the 30 ms p95 gateway budget (ADR-0008) **excludes** strict mode. Strict mode has its own budget, **proposed as ≤ 50 ms p95 added in total** (30 ms deterministic + ≤ 20 ms for the two durable enqueues). It becomes binding only once the reference-runner benchmark confirms it's achievable; if not, the budget is revised in this ADR, never silently. It's measured as a separate scenario in the nightly benchmark.
5. **Configuration checks at boot:** where `CONFIG GET` is allowed (Valkey/Redis self-hosted), verify `appendonly`, `appendfsync` and `maxmemory-policy noeviction` for each store's role, and refuse to start on a mismatch. Managed services with `CONFIG` restricted declare their store type (`memorydb`, `elasticache`) in config instead, and the boot check validates it against `INFO server` / `INFO persistence`.

## Consequences
- Two Redis-compatible stores per region (standard + durable) in SaaS and in strict self-hosted setups. That's more to operate, but each has a clear role.
- The standard (non-strict) SaaS loss window on ElastiCache is replication lag on failover. That's acceptable only because SaaS event streams live on MemoryDB (decision 2). If MemoryDB is rejected, ADR-0004's "≤ 1 s" claim must be restated for SaaS.

## Alternatives
- **WAITAOF on an `everysec` instance:** rejected, 0–1000 ms per strict request.
- **`appendfsync always` for the whole shared instance:** simplest, but every tenant, plus BullMQ and rate limiting, pays the fsync cost.
- **Kafka with `acks=all` for strict tenants:** strong durability, but another stateful system (see ADR-0004 alternatives).
