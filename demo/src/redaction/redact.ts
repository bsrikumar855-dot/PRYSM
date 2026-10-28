import { detect, resolve, type PiiKind, type Span } from './detect.ts';

export type Finding = Span;

export interface RedactedText {
  /** The normalized text with every finding replaced by a [REDACTED:KIND] marker. */
  text: string;
  /** Offsets into the normalized text. No matched value is ever stored. */
  findings: Finding[];
}

/** Zero-width space, non-joiner, joiner, word joiner, BOM and soft hyphen, by code point so no invisible character sits in the source. */
const INVISIBLE = [0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x00ad].map((cp) => String.fromCodePoint(cp));

/** NFKC normalization (fullwidth digits become ASCII) and zero-width stripping, so tricks don't hide PII. */
export function normalize(text: string): string {
  let out = text.normalize('NFKC');
  for (const ch of INVISIBLE) out = out.replaceAll(ch, '');
  return out;
}

/** Redacts email addresses, Indian and international phone numbers, PAN and Aadhaar (Verhoeff-valid). */
export function redactText(input: string): RedactedText {
  const text = normalize(input);
  const findings = resolve(detect(text));
  let out = '';
  let cursor = 0;
  for (const f of findings) {
    out += text.slice(cursor, f.start) + `[REDACTED:${f.kind.toUpperCase()}]`;
    cursor = f.end;
  }
  return { text: out + text.slice(cursor), findings };
}

export type RedactionCounts = Record<PiiKind, number>;

/** How many of each kind were found. Safe to log: counts only. */
export function countFindings(findings: readonly Finding[]): RedactionCounts {
  const counts: RedactionCounts = { aadhaar: 0, pan: 0, email: 0, phone: 0 };
  for (const f of findings) counts[f.kind] += 1;
  return counts;
}

/** The only redaction fields that may go into a log line or an evidence record. */
export function redactionLogFields(findings: readonly Finding[]): {
  redaction_total: number;
  redaction_counts: RedactionCounts;
} {
  return { redaction_total: findings.length, redaction_counts: countFindings(findings) };
}

const MAX_DEPTH = 32;

/**
 * Redacts every string inside JSON-shaped data (chat messages, tool arguments), keeping the structure and the
 * object keys. Throws RangeError past depth 32 so a hostile payload cannot recurse without bound; the gateway
 * treats that as a deny.
 */
export function redactValue(value: unknown, depth = 0): { value: unknown; findings: Finding[] } {
  if (depth > MAX_DEPTH) throw new RangeError('payload nests too deeply to redact');
  if (typeof value === 'string') {
    const r = redactText(value);
    return { value: r.text, findings: r.findings };
  }
  if (Array.isArray(value)) {
    const findings: Finding[] = [];
    const items = (value as unknown[]).map((item) => {
      const r = redactValue(item, depth + 1);
      findings.push(...r.findings);
      return r.value;
    });
    return { value: items, findings };
  }
  if (value !== null && typeof value === 'object') {
    const findings: Finding[] = [];
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const r = redactValue(item, depth + 1);
      findings.push(...r.findings);
      Object.defineProperty(out, key, { value: r.value, enumerable: true, writable: true, configurable: true });
    }
    return { value: out, findings };
  }
  return { value, findings: [] };
}
