# ADR-0008: Gateway streaming strategy

Status: Accepted · 2026-09-24

## Context

Most production LLM traffic is streamed (SSE). Controls may need to redact or block content in responses. Once a token has been sent to the client, it can't be taken back. We must also add ≤ 30 ms p95 for deterministic checks.

## Decision

### Transport

- Fastify handles ingress. **undici** calls upstream with a keep-alive pool per provider host. Bodies are streamed end to end using Node streams, with backpressure.
- Protocol adapters normalize to an internal event model and write back the original wire format byte-compatibly. The adapters are:
  - **OpenAI:** `POST /v1/chat/completions`, `/v1/responses`, `/v1/embeddings`, `/v1/models`. SSE `data:` lines, `[DONE]` for chat, typed events for Responses.
  - **Anthropic:** `POST /v1/messages`, `/v1/messages/count_tokens`. SSE events `message_start`, `content_block_start/delta/stop`, `message_delta`, `message_stop`, `ping`, `error`.
  - Tool-call argument deltas are accumulated and inspected as text too.
  - Image and audio content is **metadata-only in v1**: type, size and hash are recorded, the content isn't inspected, and the event is marked so.
- **Upstream provider credentials:** both modes are supported. The default is **stored**, encrypted with the tenant DEK and decrypted per request in memory only. In **pass-through** mode the client sends its provider key in the standard auth header, and PRYSM authenticates with its own key in `X-Prysm-Key`. Pass-through keys are never logged, persisted, or written to events or traces, and a log-scanning test enforces it.
- Contract tests replay recorded real provider responses (fixtures captured with our keys, scrubbed) through each adapter and assert byte-level round-trip plus correct parsing.

### Inspection modes

The compiled policy (ADR-0005) declares a mode per rule. The gateway uses the strictest mode among the rules that apply to the request.

| Mode          | Behaviour                                                                                                                                                                                                                                                            | Can redact? | Can block before any leak? | Added latency           |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | -------------------------- | ----------------------- |
| `passthrough` | Chunks go to the client immediately. Detectors run incrementally on a rolling buffer. On violation: annotate the event and, if the rule says so, terminate the stream with a provider-shaped error                                                                   | No          | No, only stop it           | ~0                      |
| `holdback`    | Keeps back the last **W** characters, where W is the max span of the active detectors, which each declare their own max span (e.g. Aadhaar with separators 14, card number 23). Text is released once it's beyond any possible match window, with redactions applied | Yes         | Yes, for detectable spans  | Token latency + W chars |
| `buffered`    | Buffers the whole response, evaluates, then releases it as a synthesized stream or JSON                                                                                                                                                                              | Yes         | Yes                        | Full generation time    |

- Detectors with unbounded spans can't run in `holdback`. The policy compiler rejects that combination, which forces `buffered`.
- Terminating a stream sends the upstream `AbortController` signal so the customer isn't billed for tokens nobody reads.

### Hot path budget

- Request path: key lookup (in-memory LRU backed by Redis, key hashes only) → rate limit and budget (Redis Lua, single round trip) → detectors on the prompt → `evaluate(pre)`. Everything except Redis is CPU-only.
- Built-in detectors are linear-time: hand-reviewed regexes with no nested quantifiers, fuzzed with long adversarial inputs in CI, and checksum validation (Verhoeff, Luhn, GSTIN mod-36) that runs only on candidate matches. Customer-defined patterns run through RE2.
- Event emission is fire-and-forget to Redis Streams, with the spool fallback (ADR-0004). The response never waits on an evidence write.
- **Benchmark gate:** autocannon/k6 scenarios in `apps/gateway/bench` run against a mock upstream with fixed latency. The benchmark measures _added_ latency (gateway minus mock) at 500 RPS and fails if p95 > 30 ms. The runner spec is recorded with the results. There is no dedicated runner yet (owner, 2026-09-24), so the gate runs as a **blocking nightly job** and as a **non-blocking check on PRs**, which reports a regression without failing. When a dedicated runner exists, the PR check becomes blocking. **Strict-durability tenants are excluded from the 30 ms budget.** They have their own budget and benchmark scenario (ADR-0009).

### Policy hot reload

Gateways subscribe to `policy.published` (Redis pub/sub) and fetch the compiled artifacts from `api` by hash. They validate the hash, then swap an immutable in-memory map atomically. In-flight requests finish on the version they started with. Every event records the policy hash it was evaluated with. There is also a periodic full resync, so a gateway that misses a notification doesn't drift.

### Failure modes

- Upstream error or timeout is passed through in the provider's shape and recorded.
- PRYSM internal failure (a detector throws, or Redis is unavailable for rate limiting) follows the per-application `failure_mode`. `closed` returns a 503 in provider shape. `open` forwards the request and records `enforcement_skipped` evidence with the reason.

## Consequences

- `holdback` gives most of the protection of `buffered` for PII at near-streaming UX. It's the default for redaction rules.
- Semantic checks (forbidden-content categories via LLM) can't block streams inline. They're async unless a control explicitly sets `buffered` + blocking, which the console flags with an estimated latency cost.

## Alternatives

- **Envoy / ext_proc:** mature proxying, but the policy logic would live out-of-process in another runtime, and SSE-aware rewriting is awkward there.
- **Rust or Go gateway:** faster per core, but the policy engine and detectors would have to be duplicated or embedded. Revisit only if the TypeScript benchmark gate can't be met.
