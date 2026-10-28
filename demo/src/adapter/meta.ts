import { parseCompletion, promptedInstructions } from './parse.ts';
import { ModelError, type ChatModel, type ChatRequest, type ChatResult, type ToolMode } from './types.ts';

// DEMO-ONLY (TODO(T-001)). Client for the Meta Model API's OpenAI-compatible Chat Completions endpoint
// (https://dev.meta.ai/docs). The key is sent only in the Authorization header and never appears in a message,
// a log line or an error. The response shape below is the OpenAI chat completion shape the docs describe; it has
// not been confirmed against a live call (see scripts/verify-meta-live.ts).

export interface MetaConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  /** For tests: replaces global fetch. */
  fetchImpl?: typeof fetch;
}

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/** Reads META_MODEL_API_BASE_URL, META_MODEL_API_KEY and META_MODEL_NAME. Returns null when no key is set. */
export function metaConfigFromEnv(env: NodeJS.ProcessEnv = process.env): MetaConfig | null {
  const apiKey = env['META_MODEL_API_KEY'];
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl: env['META_MODEL_API_BASE_URL'] ?? 'https://api.meta.ai/v1',
    model: env['META_MODEL_NAME'] ?? 'muse-spark-1.3',
  };
}

export class MetaChatModel implements ChatModel {
  readonly name: string;
  readonly #config: Required<Omit<MetaConfig, 'fetchImpl'>> & { fetchImpl: typeof fetch };

  constructor(config: MetaConfig) {
    if (/contributor/i.test(config.model)) {
      throw new ModelError(
        'config',
        'Contributor-mode models are not used by this demo; pick a standard model such as muse-spark-1.3',
      );
    }
    let url: URL;
    try {
      url = new URL(config.baseUrl);
    } catch (error) {
      throw new ModelError('config', 'META_MODEL_API_BASE_URL is not a valid URL', { cause: error });
    }
    if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
      throw new ModelError('config', 'the model API base URL must use https (loopback is allowed for tests)');
    }
    this.name = `meta:${config.model}`;
    this.#config = {
      baseUrl: config.baseUrl.replace(/\/+$/, ''),
      apiKey: config.apiKey,
      model: config.model,
      timeoutMs: config.timeoutMs ?? 30_000,
      fetchImpl: config.fetchImpl ?? fetch,
    };
  }

  /** One request; returns the HTTP status and the JSON body exactly as received (for shape checks). */
  async completeRaw(request: ChatRequest): Promise<{ status: number; body: unknown }> {
    const mode: ToolMode = request.toolMode ?? 'auto';
    const messages =
      mode === 'prompted' && request.tools.length > 0
        ? [{ role: 'system', content: promptedInstructions(request.tools) }, ...request.messages]
        : request.messages;
    const payload: Record<string, unknown> = { model: this.#config.model, messages };
    if (mode !== 'prompted' && request.tools.length > 0) {
      payload['tools'] = request.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.#config.timeoutMs);
    try {
      const response = await this.#config.fetchImpl(`${this.#config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.#config.apiKey}` },
        body: JSON.stringify(payload),
        signal: controller.signal,
        redirect: 'error',
      });
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES)
        throw new ModelError('invalid-response', 'the model response is too large');
      if (!response.ok) throw new ModelError('http', `the model API answered HTTP ${String(response.status)}`);
      try {
        return { status: response.status, body: JSON.parse(text) as unknown };
      } catch (error) {
        throw new ModelError('invalid-response', 'the model response was not JSON', { cause: error });
      }
    } catch (error) {
      if (error instanceof ModelError) throw error;
      if (controller.signal.aborted)
        throw new ModelError('timeout', 'the model API did not answer in time', { cause: error });
      // The underlying message can mention the URL but never the headers; keep only a generic text.
      throw new ModelError('network', 'the model API could not be reached', { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }

  async complete(request: ChatRequest): Promise<ChatResult> {
    const { body } = await this.completeRaw(request);
    const result = parseCompletion(body, { tools: request.tools, toolMode: request.toolMode ?? 'auto' });
    if (!result) throw new ModelError('invalid-response', 'the model response is not a chat completion');
    return result;
  }
}
