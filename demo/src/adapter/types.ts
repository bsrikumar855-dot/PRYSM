// DEMO-ONLY (TODO(T-001)). The model sits behind this interface. Model output is untrusted: whatever comes back is
// parsed and validated here, and a tool request that cannot be validated is carried forward as a denied call, never
// as a guess.

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

export interface ToolDef {
  name: string;
  description: string;
  /** A JSON Schema object describing the arguments. Passed to the model; the policy engine does the deciding. */
  parameters: Record<string, unknown>;
}

/** 'native' sends tools through the API; 'prompted' asks for a JSON tool request in plain text; 'auto' does native and falls back. */
export type ToolMode = 'native' | 'prompted' | 'auto';

export interface ChatRequest {
  messages: ChatMessage[];
  tools: ToolDef[];
  toolMode?: ToolMode;
}

export type ParsedToolCall =
  | { ok: true; id: string; name: string; arguments: Record<string, unknown> }
  | { ok: false; id: string; name: string | null; reason: string };

export interface ChatResult {
  /** The assistant's text, if any. Never shown to anyone before redaction and never used to make a decision. */
  content: string | null;
  toolCalls: ParsedToolCall[];
  /** How the tool calls were obtained. */
  mode: 'native-tool-calls' | 'prompted-json' | 'none';
  finishReason: string | null;
  /** Problems found while parsing (for the log); never contains the model's text. */
  notes: string[];
}

export interface ChatModel {
  /** A label for logs and evidence, e.g. "meta:muse-spark-1.3" or "replay". */
  readonly name: string;
  complete(request: ChatRequest): Promise<ChatResult>;
}

/** Thrown when the model cannot be reached or answers with something that is not a chat completion. */
export class ModelError extends Error {
  readonly kind: 'http' | 'network' | 'timeout' | 'invalid-response' | 'replay-miss' | 'config';
  constructor(kind: ModelError['kind'], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ModelError';
    this.kind = kind;
  }
}
