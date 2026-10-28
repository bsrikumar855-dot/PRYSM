import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import { z } from 'zod';
import { policySchema, type Policy } from './schema.ts';

/** A validated policy plus a content hash, so a decision can name exactly which policy produced it. */
export interface CompiledPolicy {
  policy: Policy;
  /** SHA-256 of the canonical (sorted-key) JSON of the policy, hex. */
  hash: string;
}

/** JSON with object keys sorted, so equal policies hash equally whatever order the YAML wrote them in. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Validates an already-parsed policy object and hashes it. Throws with every problem listed. */
export function compilePolicy(input: unknown): CompiledPolicy {
  const result = policySchema.safeParse(input);
  if (!result.success) throw new Error(`Invalid policy:\n${z.prettifyError(result.error)}`);
  return { policy: result.data, hash: createHash('sha256').update(canonicalJson(result.data)).digest('hex') };
}

/**
 * Parses policy YAML and compiles it. YAML aliases and merge keys are refused, and duplicate keys are an error,
 * so a policy reads the same to a human and to the engine.
 */
export function parsePolicyYaml(text: string): CompiledPolicy {
  let raw: unknown;
  try {
    raw = parse(text, { maxAliasCount: 0, uniqueKeys: true, merge: false });
  } catch (error) {
    throw new Error(`Policy is not valid YAML: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  return compilePolicy(raw);
}
