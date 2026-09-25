# ADR-0005: Policy language (CEL-based DSL)

Status: Accepted · 2026-09-24

## Context

Controls need executable policies that are declarative, versioned, reviewable by non-engineers, deterministic, fast enough for the gateway hot path, and simulatable against history. Principle 1: an LLM can't make the final call.

## Decision

### Format

Policies are YAML documents validated by a zod schema (`packages/core-types`). Conditions are **CEL** expressions.

```yaml
apiVersion: prysm/v1
kind: Policy
metadata: { id: pol_no_aadhaar_egress, control: ctl_pii_minimisation, version: 3 }
on: gateway.request # gateway.request | gateway.response | schedule | collector.<type>
requires:
  detectors: [in.aadhaar, in.pan, secrets.generic]
rules:
  - id: block-aadhaar
    tier: deterministic
    when: facts.detectors["in.aadhaar"].count > 0 && app.data_class != "kyc"
    action: redact # allow | annotate | redact | replace | block
    severity: high
    stream: holdback # passthrough | holdback | buffered (ADR-0008)
  - id: judge-financial-advice
    tier: llm_judge # always async, never on the hot path
    judge: { template: fin_advice_v2, model_class: small, threshold: 0.85 }
    when: app.sector == "fintech"
    severity: medium
```

### Compilation (`policy-engine.compile`)

Parse → schema-validate → CEL parse and **type-check** against the declared input schema for the `on` trigger → check that referenced detectors exist and that their versions are pinned → produce a JSON `CompiledPolicy` holding the checked ASTs, action precedence, the required stream mode and detector list, and a `sha256` content hash. Only compiled artifacts get published. Gateways load them by hash.

### Evaluation (`policy-engine.evaluate(compiled, input) → Decision`)

- **Pure.** No I/O, clock or randomness. `now`, app metadata and detector facts are all passed in. Detectors run _outside_ the engine (`packages/detectors`) and their results arrive as `facts`. That lets simulation reuse stored facts for tenants on metadata-only retention, where raw payloads don't exist.
- **Cost-bounded.** There is a static cost estimate at compile time and a runtime budget per evaluation. `matches()` uses RE2 semantics, and customer regex is compiled with an RE2 engine (no backtracking).
- **Deterministic conflicts.** When several rules fire, `block > replace > redact > annotate > allow`, with ties broken by rule id. A Decision includes a full trace (which rules matched, their values, and the policy hash).
- **`llm_judge` rules are never evaluated inline.** The engine emits a `judge_request`, and workers call the ai-service. The result is an Evaluation with `source=llm`, `confidence`, `rationale`, model and template version. Below the threshold it becomes a ReviewItem. At or above the threshold it may open a Finding in state **`pending_confirmation`** only. An LLM result can never pass or close a control. Pending findings are excluded from control-status scores until a human confirms or dismisses them (owner decision, 2026-09-24).
- **LLM features are optional.** With no LLM configured, `llm_judge` rules compile, but they are marked unavailable in the console and produce no evaluations. All deterministic features work unchanged.

### Simulation

`simulate(draftCompiled, historicalInputs[]) → diff` against the currently published policy. The same pure function also runs in workers over the last N days of stored facts and payloads, where retention allows.

### Library

We use a maintained TypeScript CEL implementation. In M3 we evaluate candidates (e.g. `@bufbuild/cel`, `cel-js`) against the subset of the cel-spec conformance tests we use, plus fuzzing. The chosen library is pinned and wrapped behind `policy-engine`, and no other package imports it.

## Consequences

- JS CEL implementations are younger than cel-go. **That is a risk.** Mitigations: conformance tests, restricting the language subset (no macros we don't test), and a wrapper module so the implementation can be swapped.
- Policy authors write CEL. The console gets templates, an expression builder for common cases, and simulation before publish.

## Alternatives

- **OPA/Rego:** powerful and mature, but Rego is hard for non-engineers to review. The WASM runtime adds latency and complexity in Node, and "pure + typed input" is harder to enforce.
- **JSON Logic:** simple, but untyped and verbose. There's no compile-time type-checking.
- **A custom DSL:** we'd own the grammar, the tooling and the bugs forever.
