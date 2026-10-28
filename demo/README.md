# demo/ (DEMO-ONLY)

The Meta Global AI Developer Hackathon slice of PRYSM. Everything here is **DEMO-ONLY**: it is built to show the idea
in two days, single-tenant, with synthetic data. It is not part of the product build, and nothing in `apps/` or
`packages/` depends on it. Each shortcut carries a `DEMO-ONLY` label in the code and a `TODO(T-###)` entry in
`docs/TRACKING.md` section 4 (T-001 the workspace, T-002 the lint exemption, T-003 the unauthenticated server).

## What it shows

An AI agent asks a model to do things. PRYSM sits in between and produces **control status** with **evidence of** each
decision:

1. **Redaction.** Email, phone, PAN and Aadhaar are removed from the prompt before it reaches the model or any log.
   Only counts are recorded.
2. **A policy decides, not the model.** The model proposes a tool call; a YAML policy (`policies/demo-policy.yaml`)
   returns `allow`, `deny` or `require_approval`. Unknown tools, and tools no rule covers, are denied by default.
3. **People decide the rest.** A `require_approval` call waits until a named person approves or denies it.
4. **Tamper-evident evidence.** Every step is a record in an append-only table, hash-chained
   (`record_hash = SHA-256(prev_hash || canonical_json)`), with a head hash kept in a file outside the database.

## Run it (one command, then a second terminal)

You need Node 24 (`.nvmrc`), `pnpm install`, and Docker. Replay mode needs no API key and no network.

```bash
pnpm install
pnpm demo:start        # starts Postgres, creates the demo database, migrates, seeds, then serves http://127.0.0.1:4300
```

`pnpm demo:start` is `pnpm demo:up && pnpm demo:serve`. Run them separately if you prefer. If something else already
uses Postgres' port 5432, set `DEMO_PG_PORT`, or use a local `infra/docker/compose.override.yml` (it is picked up).

In a second terminal:

```bash
pnpm demo:agent -- --auto-approve demo-script   # runs the three scenarios; omit the flag to approve in the browser
pnpm demo:verify                                # checks the stored chain against the anchor
pnpm demo:reset                                 # start over after a tamper demonstration (empties the table, deletes the anchor)
pnpm demo:export                                # writes demo/.out/evidence-pack.json and anchor.json
pnpm demo:verify -- --pack demo/.out/evidence-pack.json --anchor demo/.out/anchor.json   # offline, no database
```

## The 3-minute script

| Time | Do this                                                                                              | Say this                                                                                                                                                         |
| ---- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0:00 | Open http://127.0.0.1:4300. Point at the green badge.                                                | "Every model tool request becomes a record in a hash chain. The badge is the live verification result."                                                          |
| 0:20 | `pnpm demo:agent` (no flag). Watch scenario 1 and 2 scroll by in the feed.                           | "Scenario 1 reads an order: allowed. The prompt had an email, phone and PAN; the model never saw them. Scenario 2 asks for a bulk export: the policy denies it." |
| 1:00 | Scenario 3 stops: a refund of INR 9000 appears in the Approval queue. Type your name, click Approve. | "Above the limit the policy says require_approval. The agent waits. My decision, and my name, are now evidence."                                                 |
| 1:30 | Point at the feed: tool decisions with their rule and source.                                        | "Each decision names the rule and the source id from the policy file. The model proposed; the policy and a person decided."                                      |
| 1:50 | In "Tamper", leave record 2 and click **Edit this record**.                                          | "I just edited a record as a database administrator. Verification fails at exactly that record."                                                                 |
| 2:20 | Click **Reset the demo**, run the agent again, then click **Rewrite the chain from this record**.    | "Now the attacker rewrites every hash. The chain still checks out on its own. Only the anchor, kept outside the database, shows the rewrite."                    |
| 2:50 | Run `pnpm demo:export` then the offline `verify` command.                                            | "An auditor can check the pack and the anchor with no database and no network."                                                                                  |

## Model modes

| `DEMO_MODEL_MODE`  | What happens                                                                                                                                                                              |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `replay` (default) | Answers from `fixtures/replay.json`. Offline. The fixtures are **hand-written** from the OpenAI-compatible response shape in the Meta Model API docs and say so; they are not recordings. |
| `live`             | Calls the Meta Model API (`https://api.meta.ai/v1`, bearer key, a standard model such as `muse-spark-1.3`; contributor models are refused).                                               |
| `record`           | Live, and also writes each response to `demo/.out/recorded.json`, keyed by request hash, for later replay.                                                                                |

Put the key in an untracked `.env.demo` (never committed, never printed):

```
META_MODEL_API_KEY=...
META_MODEL_API_BASE_URL=https://api.meta.ai/v1
META_MODEL_NAME=muse-spark-1.3
```

`pnpm demo:live-check` makes ONE chat call and ONE tool-calling call and prints the response shape (keys and types) so you
can see whether the documented OpenAI-compatible tool-calling shape holds. With no key it says SKIPPED.

**Tool calls are untrusted.** Mode A reads native `tool_calls`. If they are missing or malformed, Mode B looks for a JSON tool
request in the text, validated with zod. Anything malformed, oversized, or naming a tool that was not offered is denied and
logged, never repaired.

## What the evidence log is, and is not

- Append-only in the database: the app role has `SELECT` and `INSERT` only, and triggers refuse `UPDATE`, `DELETE` and
  `TRUNCATE`. The demo's tamper buttons use a separate administrator connection that can switch the triggers off, to show
  what an insider could do.
- The hash chain catches edits, deletions and reordering at the first bad record.
- A full rewrite is caught only by the **anchor**, a small file outside the database. In the product that would live where the
  database operator cannot write; in the demo it is a local file, so it shows the idea and protects nothing against someone
  who can write that file too.

## Limits (cut for the two days)

- Single tenant, no login: the approver is a free-text label (T-003). The server binds to 127.0.0.1 only.
- No streaming responses.
- The policy language is a small structured one, not the CEL-based language of ADR-0005.
- The policy file's `source` ids are placeholders. The operator supplies real document ids and versions; the code invents none.
- The Llama explanation endpoint (advisory only) is not built yet; it waits for a working live key.
