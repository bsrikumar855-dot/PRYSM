# Working rules

Standing rules for whoever implements PRYSM: the owner's coding agent, a contributor, or any other automated implementer. They sit beside [CLAUDE.md](../../CLAUDE.md), which holds the product principles, and the ADRs in [docs/adr/](../adr/README.md), which hold the decisions. If a rule here and an Accepted ADR seem to disagree, stop and ask the owner.

Adopted by the owner on 2026-10-30. The phase-by-phase work order is not part of these rules; milestone plans live in [docs/plans/](../plans/) and requirement status in [docs/TRACKING.md](../TRACKING.md).

## Roles

- **Owner:** Shreekumar (GitHub `bsrikumar855-dot`). Decides scope, approves plans and merges.
- **Implementer:** works in `~/PRYSM`, writes code, tests, migrations and docs, and reports.
- **Advisor:** an external reviewer who reads the implementer's reports. Reports must therefore stand alone.

The `demo/meta-slice` branch and PR #24 are the hackathon demo. Do not touch them unless the owner says so.

## Authority (hard rules)

1. **Never merge.** Only the owner merges (merge commit, no squash). The only phrase that lets the implementer merge is "merge PR <n>". A printed statistic, a question, or "do it yourself" is not permission.
2. **Never, without explicit approval in the owner's latest message:** force-push, rewrite published history, delete branches, change repository, CI or branch-protection settings, enable auto-fix, or add advisory ignores.
3. **Never assume a PR is merged.** Run `git fetch`, then `git merge-base --is-ancestor <sha> origin/main`.
4. **Schema changes only through migrations.** Never hand-edit a shared dev database.
5. **Decide small things yourself** and record the decision in the PR description. Stop and ask only at the stop conditions below.

## Engineering rules

- The CLAUDE.md principles hold: the LLM never has the final say; no uncited rule; immutable evidence; absolute tenant isolation (any cross-tenant read is P0); a fast, deterministic gateway path; privacy by default; never invent regulation text.
- **Wording:** "control status" and "evidence of". Never state that anyone meets a law or a standard. CI enforces this.
- **Commits:** after every small change; conventional commits; lowercase subject; body at most 100 columns. Run commitlint on the message first. Chain the checks and the commit with `&&`; never commit on a red check.
- **Checks before every push:**
  - `TURBO_FORCE=true pnpm check` (the turbo cache can hide tests)
  - commitlint over the whole branch
  - gitleaks in CI mode
  - OSV with the exact command from `.github/workflows/ci.yml`
  - migrations applied twice to an empty database
  - `drizzle-kit generate` leaves no diff
- **Security-relevant tests are proven by mutation:** break the control, show the test failing by name, restore it, show green.
- **Migrations are forward-only.** A change is a new migration. Print the final SQL, grants and policies inline in the report.
- **Dependencies:** exact pins, at least 7 days old, and every new direct dependency justified.
- **No silent stubs.** Every TODO is `TODO(T-###)` in the registry; a feature that is not available is marked unavailable.
- **Tests use synthetic data only.** No payloads, keys or personal data in logs.
- **TRACKING rows flip only with evidence** (a test or a CI link). Partial work is `[~]`.
- **Every PR description says:** what, why, decisions taken, tests, risks.

## Report format

After every PR, inline in the reply and never as an attachment, at most five numbered items:

1. What changed (SQL and grants inline, if any).
2. Tests, with counts and proof that the forced run executed.
3. Mutation proofs.
4. Each gate, including failures, unedited.
5. CI per job, and the decisions that need the owner.

Always state the PR number, the head sha and "not merged".

## Pipeline for every milestone

- **A. Plan gate.** Write `docs/plans/M<n>-<name>.md`: PR breakdown, definitions of done mapped to TRACKING ids, risks, and the ADRs needed. Open a docs PR and stop for approval. (M1's plan exists, so M1 skips this step.)
- **B. Build in small PRs,** aiming for at most 600 changed lines excluding lockfiles and generated files, each with tests. Open the PR and stop for review. While one PR waits, the next may start on a stacked branch. At most two PRs are open at once. Never rebase without approval.
- **C. Milestone gate.** Implement and run the TRACKING "Gate (demo)" sentence for that milestone literally (`pnpm verify:m<n>`), report, flip rows with evidence, and stop.

## Stop conditions

Stop and report, without improvising, on any of these:

- any cross-tenant read
- a security test that cannot be made to fail under mutation
- a paid service, credential or account is needed
- a choice that contradicts an Accepted ADR
- a security design choice no ADR covers
- a major dependency bump
- CI red for reasons outside the change
- two failed attempts at the same problem
- any ambiguity about merge authority
