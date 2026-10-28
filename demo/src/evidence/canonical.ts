// DEMO-ONLY (TODO(T-001)). Canonical JSON for the evidence log. A deliberately strict subset of JSON, so the same
// value always encodes to the same bytes and nothing ambiguous is ever hashed:
//
//   - the encoding is UTF-8 text with no whitespace;
//   - object keys are sorted by UTF-16 code unit order (the default JavaScript string order, as in RFC 8785);
//   - strings are written by JSON.stringify (standard escapes; lone surrogates are escaped, never emitted raw);
//   - numbers must be safe integers. Floats, NaN and Infinity are refused, so no number can encode two ways
//     (record decimals as strings, as ADR-0006 does);
//   - undefined, bigint, functions, symbols, Date, Map and class instances are refused rather than guessed at;
//   - nesting deeper than 32 levels is refused.

const MAX_DEPTH = 32;

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** Encodes `value` as canonical JSON, or throws TypeError if it falls outside the subset above. */
export function canonicalize(value: unknown, depth = 0): string {
  if (depth > MAX_DEPTH) throw new TypeError('canonical JSON: nesting is too deep');
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isSafeInteger(value)) throw new TypeError(`canonical JSON: ${String(value)} is not a safe integer`);
      return String(value);
    case 'object': {
      if (Array.isArray(value))
        return `[${(value as unknown[]).map((item) => canonicalize(item, depth + 1)).join(',')}]`;
      if (!isPlainObject(value)) throw new TypeError('canonical JSON: only plain objects and arrays are allowed');
      const keys = Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k], depth + 1)}`).join(',')}}`;
    }
    default:
      throw new TypeError(`canonical JSON: ${typeof value} values are not allowed`);
  }
}
