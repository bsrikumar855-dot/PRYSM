import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// DEMO-ONLY (TODO(T-001)). Where the demo's database is and how to reach it. The credentials are the throwaway
// dev-only ones from sql/000_provision.sql; override the whole URL with DEMO_DATABASE_URL_APP / _OWNER.

export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const DEMO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const DEFAULT_ANCHOR_PATH = `${DEMO_ROOT}.anchor/anchor.json`;
export const OUT_DIR = `${DEMO_ROOT}.out`;

/**
 * `-f` arguments for the dev compose file, plus the developer's own override file if there is one, else the port override
 * that `pnpm demo:up` generates when the default Postgres port is busy.
 */
export function composeFileArgs(): string[] {
  const args = ['-f', `${REPO_ROOT}infra/docker/compose.dev.yml`];
  const override = `${REPO_ROOT}infra/docker/compose.override.yml`;
  const generated = `${OUT_DIR}/compose.ports.yml`;
  if (existsSync(override)) args.push('-f', override);
  else if (existsSync(generated)) args.push('-f', generated);
  return args;
}

/** The host port Postgres is published on: DEMO_PG_PORT, else what docker compose reports, else 5432. */
export function resolvePgPort(env: NodeJS.ProcessEnv = process.env): number {
  if (env['DEMO_PG_PORT']) return Number(env['DEMO_PG_PORT']);
  try {
    const out = execFileSync('docker', ['compose', ...composeFileArgs(), 'port', 'postgres', '5432'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const port = Number(out.split(':').pop());
    if (Number.isInteger(port) && port > 0) return port;
  } catch {
    // docker not available or the service is not running: fall back to the default
  }
  return 5432;
}

export interface DemoDbUrls {
  app: string;
  owner: string;
}

export function demoDbUrls(env: NodeJS.ProcessEnv = process.env): DemoDbUrls {
  const port = resolvePgPort(env);
  return {
    app:
      env['DEMO_DATABASE_URL_APP'] ??
      `postgres://prysm_demo_app:prysm-demo-app-dev-only@127.0.0.1:${String(port)}/prysm_demo`,
    owner:
      env['DEMO_DATABASE_URL_OWNER'] ??
      `postgres://prysm_demo_owner:prysm-demo-owner-dev-only@127.0.0.1:${String(port)}/prysm_demo`,
  };
}

export const DEFAULT_POLICY_PATH = `${DEMO_ROOT}policies/demo-policy.yaml`;
