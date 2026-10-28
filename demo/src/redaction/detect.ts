import { verhoeffValid } from './verhoeff.ts';

export type PiiKind = 'aadhaar' | 'pan' | 'email' | 'phone';

/** Where a match sits in the normalized text. It deliberately carries no copy of the matched value. */
export interface Span {
  kind: PiiKind;
  start: number;
  end: number;
}

// Every pattern below has bounded quantifiers and no nesting, so matching is linear in the input; the email
// detector scans outward from each "@" instead of using a regex. A test feeds long adversarial inputs.

const AADHAAR = /(?<![\d])[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}(?![\d])/g;
const PAN = /(?<![A-Za-z0-9])[A-Z]{3}[PCHABGJLFT][A-Z]\d{4}[A-Z](?![A-Za-z0-9])/gi;
const PHONE_IN = /(?<![\d])(?:\+91[ -]?|91[ -]?|0)?[6-9]\d{4}[ -]?\d{5}(?![\d])/g;
const PHONE_INTL = /(?<![\w+])\+(?!91)[1-9]\d{0,2}(?:[ -]?\(?\d{2,5}\)?){2,4}(?![\d])/g;

const LOCAL_CHAR = /[A-Za-z0-9._%+-]/;
const DOMAIN_CHAR = /[A-Za-z0-9.-]/;
const MAX_LOCAL = 64;
const MAX_DOMAIN = 255;

function collect(
  text: string,
  pattern: RegExp,
  kind: PiiKind,
  accept: (match: string) => boolean = () => true,
): Span[] {
  const spans: Span[] = [];
  for (const m of text.matchAll(pattern)) {
    if (accept(m[0])) spans.push({ kind, start: m.index, end: m.index + m[0].length });
  }
  return spans;
}

function emails(text: string): Span[] {
  const spans: Span[] = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf('@', from);
    if (at === -1) return spans;
    from = at + 1;
    let start = at;
    while (start > 0 && at - start < MAX_LOCAL && LOCAL_CHAR.test(text.charAt(start - 1))) start -= 1;
    let end = at + 1;
    while (end < text.length && end - at - 1 < MAX_DOMAIN && DOMAIN_CHAR.test(text.charAt(end))) end += 1;
    // Trim trailing dots and hyphens so "mail me at a@b.com." does not swallow the full stop.
    while (end > at + 1 && /[.-]/.test(text.charAt(end - 1))) end -= 1;
    const domain = text.slice(at + 1, end);
    if (start < at && /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(domain)) {
      spans.push({ kind: 'email', start, end });
      from = end;
    }
  }
}

/** Finds PII in already-normalized text. Spans may overlap; `resolve` picks the winners. */
export function detect(text: string): Span[] {
  return [
    ...collect(text, AADHAAR, 'aadhaar', (m) => verhoeffValid(m.replace(/\D/g, ''))),
    ...collect(text, PAN, 'pan'),
    ...emails(text),
    ...collect(text, PHONE_IN, 'phone'),
    ...collect(text, PHONE_INTL, 'phone', (m) => {
      const digits = m.replace(/\D/g, '').length;
      return digits >= 8 && digits <= 15;
    }),
  ];
}

const PRIORITY: Record<PiiKind, number> = { aadhaar: 0, pan: 1, email: 2, phone: 3 };

/** Keeps a non-overlapping set of spans: higher-priority kinds win, then earlier, then longer. */
export function resolve(spans: Span[]): Span[] {
  const ordered = [...spans].sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind] || a.start - b.start || b.end - a.end);
  const kept: Span[] = [];
  for (const span of ordered) {
    if (!kept.some((k) => span.start < k.end && k.start < span.end)) kept.push(span);
  }
  return kept.sort((a, b) => a.start - b.start);
}
