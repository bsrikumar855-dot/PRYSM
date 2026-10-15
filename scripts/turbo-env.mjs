// Turborepo strict env mode hides every variable a task does not declare, so a connection variable that
// works from a developer's .env can silently vanish in CI (it did twice: the owner URL in M0, the
// test-admin URL in M1 PR 2). This keeps .env.example and the test task's passThroughEnv in step.

/** Variables whose names start with one of these must reach the test task. */
export const CONNECTION_PREFIXES = ['DATABASE_URL', 'VALKEY_URL', 'S3_'];

/** Names assigned in a dotenv-style file (`NAME=value`); comments and blank lines are ignored. */
export function envNames(text) {
  return [...text.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]);
}

/**
 * Connection variables declared in `envExampleText` that the `test` task in `turboConfig` does not list in
 * `passThroughEnv` (or `env`). Returns them in file order; an empty array means the two are in step.
 */
export function missingFromPassThrough(envExampleText, turboConfig) {
  const task = turboConfig.tasks?.test ?? {};
  const declared = new Set([...(task.passThroughEnv ?? []), ...(task.env ?? [])]);
  return envNames(envExampleText).filter(
    (name) => CONNECTION_PREFIXES.some((prefix) => name.startsWith(prefix)) && !declared.has(name),
  );
}
