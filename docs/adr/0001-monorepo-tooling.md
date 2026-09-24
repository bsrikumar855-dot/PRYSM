# ADR-0001: Monorepo tooling

Status: Proposed · 2026-09-24

## Context
The repo holds TypeScript services and packages, a Python service and SDK, and a Go CLI (ADR-0006). CI has to build and test only what a change affects, and one command has to run everything locally.

## Decision
- **pnpm 10 workspaces + Turborepo** for the TypeScript side. Node 24 LTS, pinned via `packageManager` and `.nvmrc`. Corepack provides pnpm.
- **uv workspace** for Python (`apps/ai-service`, `sdks/python`). Python 3.12 is pinned via `.python-version`, and uv installs it, so the host Python version doesn't matter.
- **Go module** at `apps/verifier-cli`.
- Python and Go packages each get a thin `package.json` whose `lint`/`typecheck`/`test`/`build` scripts shell out to `uv run …` or `go …`. That way `turbo run test` and Turbo's change detection cover all three languages through a single task graph.
- Shared TS config: `tsconfig.base.json` (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), ESLint flat config (typescript-eslint strict-type-checked), Prettier.
- Versioning with **Changesets** (semver per publishable package, changelogs).
- No remote cache at first. Turbo remote caching would add an external service; ask first if CI time justifies it.

## Consequences
- One lockfile per ecosystem (`pnpm-lock.yaml`, `uv.lock`, `go.sum`), each checked in CI with `--frozen-lockfile` or its equivalent.
- Three toolchains in CI. The Go part is small, and ADR-0006 covers why it's worth it.

## Alternatives
- **Nx:** more features (generators, module boundaries) than we need, and heavier config. Module boundaries can be enforced with ESLint `import/no-restricted-paths`.
- **Bazel:** hermetic and polyglot, but the operational and learning cost isn't justified at this team size.
- **Separate repos:** atomic changes across packages (types ↔ api ↔ web) would be much harder.
