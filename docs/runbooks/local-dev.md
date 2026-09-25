# Runbook: local development

Everything runs locally (owner decision 2026-09-24). Credentials in `.env.example` and `infra/docker/` are **dev-only**, and every port binds to `127.0.0.1`.

## Prerequisites

- **Node 24 LTS** (`.nvmrc`). **pnpm 12** comes from Corepack: `corepack enable`. On Windows without admin rights, use `corepack enable --install-directory "%APPDATA%\npm" pnpm` (any user directory on `PATH` works).
- **uv ≥ 0.12.5**. uv installs Python 3.12 itself, so the system Python version doesn't matter.
- **Docker** with Compose v2. The full stack plus images needs roughly 10 GB of disk. Keep Docker's disk image on a drive with room: Docker Desktop → Settings → Resources → Advanced → Disk image location.

## First run

```bash
pnpm install && uv sync --all-packages
cp .env.example .env
pnpm infra:up        # waits until healthy, then creates the Object Lock evidence bucket
pnpm db:migrate
pnpm dev             # api, gateway, workers, web, ai-service with hot reload
pnpm verify:m0       # in a second terminal
```

The one-command alternative is `pnpm stack:up`, which builds and runs every service in containers. `pnpm stack:down` stops it; add `-v` to the underlying compose command to wipe the volumes.

## Where things are

| What                            | URL / port                                                    |
| ------------------------------- | ------------------------------------------------------------- |
| api / gateway / workers         | http://127.0.0.1:4000 / :4100 / :4200 (`/healthz`, `/readyz`) |
| web                             | http://127.0.0.1:3001                                         |
| ai-service                      | http://127.0.0.1:8000                                         |
| Grafana (traces, logs, metrics) | http://127.0.0.1:3000 (admin / admin, local only)             |
| Postgres / Valkey / S3          | 5432 / 6379 / 8333                                            |

Traces: Grafana → Explore → Tempo. Logs: Explore → Loki with `{service_name="prysm-api"}`. Log attributes such as `request_id` are structured metadata, so filter with `| request_id = "<id>"`.

## Checks before a PR

`pnpm check` runs format, the wording and TODO-registry checks, lint, typecheck and all tests. The integration tests need `pnpm infra:up` and `pnpm db:migrate` first. CI also runs gitleaks, OSV, Semgrep, Trivy and the Object Lock conformance test (`.github/workflows/ci.yml`). Each can be run locally with the same `docker run` line.

## Troubleshooting

- **Docker reports a read-only file system:** the drive holding Docker's disk image is full. Free space or move the disk image (see Prerequisites).
- **Docker Desktop crashes at start with `sailor-ingest.sock ... cannot be accessed`:** quit Docker Desktop, delete `%LOCALAPPDATA%\Docker\run\sailor-ingest.sock*`, and start it again.
- **`pnpm install` fails with `ERR_PNPM_IGNORED_BUILDS`:** a new dependency has a build script. Review it, then add it to `allowBuilds` in `pnpm-workspace.yaml` with a comment giving the reason.
- **`pnpm install` rejects a version as too new:** `minimumReleaseAge` requires packages to be at least 7 days old. Pin a version that old, or wait.
- **A readiness check fails right after start:** Valkey connects asynchronously, so `/readyz` reports 503 until it's connected. That's intended.
- **Editing files on Windows:** never use PowerShell `Get-Content`/`Set-Content`, which corrupt UTF-8. See CLAUDE.md.
