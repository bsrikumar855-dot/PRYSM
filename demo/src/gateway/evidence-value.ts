// DEMO-ONLY (TODO(T-001)). Makes arbitrary (already redacted) model-supplied JSON safe to put in the evidence log,
// whose canonical encoding only accepts safe integers, plain objects and arrays of bounded depth. Nothing is
// invented: floats become their text, long strings are cut with a visible marker, and oversized structures are
// summarised.

const MAX_STRING = 512;
const MAX_ITEMS = 32;
const MAX_DEPTH = 6;

export function toEvidenceValue(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string')
    return value.length > MAX_STRING
      ? `${value.slice(0, MAX_STRING)}...[cut at ${String(MAX_STRING)} characters]`
      : value;
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : String(value);
  if (depth >= MAX_DEPTH) return '[nested too deeply]';
  if (Array.isArray(value)) {
    const items = (value as unknown[]).slice(0, MAX_ITEMS).map((v) => toEvidenceValue(v, depth + 1));
    return value.length > MAX_ITEMS ? [...items, `[${String(value.length - MAX_ITEMS)} more items]`] : items;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    const entries = Object.entries(value);
    for (const [k, v] of entries.slice(0, MAX_ITEMS)) {
      Object.defineProperty(out, k.slice(0, 128), {
        value: toEvidenceValue(v, depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    if (entries.length > MAX_ITEMS) out['_more_keys'] = entries.length - MAX_ITEMS;
    return out;
  }
  return '[unsupported value]';
}
