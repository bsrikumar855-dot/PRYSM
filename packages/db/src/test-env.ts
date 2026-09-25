/** Reads a required connection string for integration tests; fails loudly rather than skipping. */
export function requiredUrl(name: string): string {
  const value = process.env[name];
  if (!value)
    throw new Error(`${name} is not set. Start the stack (pnpm infra:up), run pnpm db:migrate, and see .env.example.`);
  return value;
}
