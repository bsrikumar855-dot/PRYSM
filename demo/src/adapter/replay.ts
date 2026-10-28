import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { canonicalize } from '../evidence/canonical.ts';
import { parseCompletion } from './parse.ts';
import { ModelError, type ChatModel, type ChatRequest, type ChatResult } from './types.ts';

// DEMO-ONLY (TODO(T-001)). Record and replay, so the demo runs offline. A fixture is a model response keyed either by
// a substring of the last user message (how the hand-written ones are keyed) or by the SHA-256 of the whole request
// (how recorded ones are keyed). The shipped fixtures are written by hand from the documented response shape and say
// so; they are not recordings of a real model.

export const REPLAY_FORMAT = 'prysm-demo-replay';

const entrySchema = z.strictObject({
  id: z.string().min(1),
  note: z.string().optional(),
  match: z.union([
    z.strictObject({ last_user_includes: z.string().min(1) }),
    z.strictObject({ request_hash: z.string().regex(/^[0-9a-f]{64}$/) }),
  ]),
  response: z.unknown(),
});

export const fixtureFileSchema = z.strictObject({
  format: z.literal(REPLAY_FORMAT),
  version: z.literal(1),
  /** Where the entries came from. The shipped file says DEMO-ONLY and hand-written. */
  label: z.string().min(1),
  entries: z.array(entrySchema),
});
export type FixtureFile = z.infer<typeof fixtureFileSchema>;

/** The hash a recorded fixture is keyed by: the request exactly as the model would have seen it. */
export function requestHash(request: ChatRequest): string {
  const canonical = canonicalize({
    messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
    tools: request.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
    toolMode: request.toolMode ?? 'auto',
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function loadFixtures(path: string): FixtureFile {
  return fixtureFileSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export class ReplayChatModel implements ChatModel {
  readonly name = 'replay';
  readonly #fixtures: FixtureFile;

  constructor(fixtures: FixtureFile) {
    this.#fixtures = fixtures;
  }

  complete(request: ChatRequest): Promise<ChatResult> {
    const lastUser = [...request.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const hash = requestHash(request);
    const entry = this.#fixtures.entries.find((e) =>
      'request_hash' in e.match ? e.match.request_hash === hash : lastUser.includes(e.match.last_user_includes),
    );
    if (!entry) return Promise.reject(new ModelError('replay-miss', 'no replay fixture matches this request'));
    const result = parseCompletion(entry.response, { tools: request.tools, toolMode: request.toolMode ?? 'auto' });
    if (!result)
      return Promise.reject(
        new ModelError('invalid-response', `replay fixture "${entry.id}" is not a chat completion`),
      );
    return Promise.resolve(result);
  }
}

/**
 * Wraps a real model and appends each response it gives to a fixture file, keyed by request hash. Record only with
 * synthetic prompts: the fixture holds whatever the model said. The API key is never part of a request body.
 */
export class RecordingChatModel implements ChatModel {
  readonly name: string;
  readonly #inner: ChatModel & { completeRaw?: (r: ChatRequest) => Promise<{ status: number; body: unknown }> };
  readonly #path: string;

  constructor(
    inner: ChatModel & { completeRaw?: (r: ChatRequest) => Promise<{ status: number; body: unknown }> },
    path: string,
  ) {
    this.#inner = inner;
    this.#path = path;
    this.name = `recording(${inner.name})`;
  }

  async complete(request: ChatRequest): Promise<ChatResult> {
    if (!this.#inner.completeRaw) return this.#inner.complete(request);
    const { body } = await this.#inner.completeRaw(request);
    const file: FixtureFile = existsSync(this.#path)
      ? loadFixtures(this.#path)
      : {
          format: REPLAY_FORMAT,
          version: 1,
          label: 'Recorded from a live model with synthetic prompts. DEMO-ONLY.',
          entries: [],
        };
    const hash = requestHash(request);
    const entries = file.entries.filter((e) => !('request_hash' in e.match) || e.match.request_hash !== hash);
    entries.push({ id: `recorded-${hash.slice(0, 12)}`, match: { request_hash: hash }, response: body });
    mkdirSync(dirname(this.#path), { recursive: true });
    writeFileSync(this.#path, `${JSON.stringify({ ...file, entries }, null, 2)}\n`, 'utf8');
    const result = parseCompletion(body, { tools: request.tools, toolMode: request.toolMode ?? 'auto' });
    if (!result) throw new ModelError('invalid-response', 'the model response is not a chat completion');
    return result;
  }
}
