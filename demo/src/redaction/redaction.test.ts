import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  countFindings,
  normalize,
  redactText,
  redactValue,
  redactionLogFields,
  verhoeffCheckDigit,
  verhoeffValid,
} from './index.ts';

// All data here is synthetic: example.test addresses, reserved-looking numbers, and Aadhaar-shaped numbers built
// with a computed Verhoeff check digit. None belongs to a real person.
const aadhaar = (prefix11: string): string => `${prefix11}${String(verhoeffCheckDigit(prefix11))}`;
const AADHAAR = aadhaar('23456789012');
const AADHAAR_SPACED = `${AADHAAR.slice(0, 4)} ${AADHAAR.slice(4, 8)} ${AADHAAR.slice(8)}`;
const AADHAAR_HYPHEN = AADHAAR_SPACED.replaceAll(' ', '-');
const PAN = 'ABCPE1234F';
const EMAIL = 'priya.nair+demo@example.test';
const PHONE = '+91 98765 43210';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Verhoeff', () => {
  it('matches the published vectors', () => {
    expect(verhoeffCheckDigit('236')).toBe(3);
    expect(verhoeffCheckDigit('12345')).toBe(1);
    expect(verhoeffCheckDigit('142857')).toBe(0);
    expect(verhoeffValid('2363')).toBe(true);
    expect(verhoeffValid('123451')).toBe(true);
    expect(verhoeffValid('1428570')).toBe(true);
  });

  it('rejects a changed digit, a transposition, and non-digits', () => {
    expect(verhoeffValid('2364')).toBe(false);
    expect(verhoeffValid('1234 51')).toBe(false);
    expect(verhoeffValid('')).toBe(false);
    const swapped = `${AADHAAR.slice(0, 3)}${AADHAAR.charAt(4)}${AADHAAR.charAt(3)}${AADHAAR.slice(5)}`;
    expect(verhoeffValid(AADHAAR)).toBe(true);
    expect(verhoeffValid(swapped)).toBe(false);
  });
});

describe('each kind is redacted', () => {
  it('email', () => {
    expect(redactText(`write to ${EMAIL}, thanks`).text).toBe('write to [REDACTED:EMAIL], thanks');
    expect(redactText('mail a@b.example.test.').text).toBe('mail [REDACTED:EMAIL].');
    expect(redactText('x@y').text).toBe('x@y'); // no dotted domain: not an address
    expect(redactText('@handle and user@ alone').text).toBe('@handle and user@ alone');
  });

  it('phone: Indian mobiles in common spellings, and international numbers', () => {
    for (const p of ['9876543210', '98765 43210', '+91 98765 43210', '+91-9876543210', '919876543210', '09876543210']) {
      expect(redactText(`call ${p} now`).text, p).toBe('call [REDACTED:PHONE] now');
    }
    expect(redactText('call +44 20 7946 0958 now').text).toBe('call [REDACTED:PHONE] now');
    expect(redactText('call +1 (415) 555 0132 now').text).toBe('call [REDACTED:PHONE] now');
  });

  it('PAN, upper or lower case', () => {
    expect(redactText(`PAN ${PAN} on file`).text).toBe('PAN [REDACTED:PAN] on file');
    expect(redactText(`pan ${PAN.toLowerCase()}`).text).toBe('pan [REDACTED:PAN]');
  });

  it('Aadhaar: plain, spaced and hyphenated, only when the Verhoeff check digit is right', () => {
    for (const a of [AADHAAR, AADHAAR_SPACED, AADHAAR_HYPHEN])
      expect(redactText(`id ${a} ok`).text, a).toBe('id [REDACTED:AADHAAR] ok');
    const wrong = `${AADHAAR.slice(0, 11)}${String((verhoeffCheckDigit(AADHAAR.slice(0, 11)) + 1) % 10)}`;
    expect(redactText(`id ${wrong}`).findings.map((f) => f.kind)).not.toContain('aadhaar');
  });
});

describe('what is left alone', () => {
  it('ordinary numbers, ids and prose', () => {
    for (const s of [
      'order ORD-1001 total 5000 INR',
      'invoice 2026-10-28',
      'version 1.2.3',
      'ISBN 9781234567897',
      'zip 560001',
      'the quick brown fox',
      'ABCDE12345',
      '1234567890123456',
      'ABCZE1234F', // 4th letter Z is not a PAN holder type
    ]) {
      expect(redactText(s).text, s).toBe(s);
    }
  });

  it('a 12-digit number that starts with 0 or 1 is not an Aadhaar', () => {
    for (const lead of ['0', '1']) {
      const digits = `${lead}2345678901`;
      expect(redactText(`n ${aadhaar(digits)}`).findings.map((f) => f.kind)).not.toContain('aadhaar');
    }
  });
});

describe('overlaps and several findings at once', () => {
  it('a valid Aadhaar is one finding, not an Aadhaar plus a phone number', () => {
    const r = redactText(`id ${aadhaar('98765432109')}`);
    expect(r.findings.map((f) => f.kind)).toEqual(['aadhaar']);
  });

  it('redacts all four kinds in one string and reports counts', () => {
    const r = redactText(`${EMAIL} ${PHONE} ${PAN} ${AADHAAR_SPACED}`);
    expect(r.text).toBe('[REDACTED:EMAIL] [REDACTED:PHONE] [REDACTED:PAN] [REDACTED:AADHAAR]');
    expect(countFindings(r.findings)).toEqual({ aadhaar: 1, pan: 1, email: 1, phone: 1 });
    expect(redactionLogFields(r.findings)).toEqual({
      redaction_total: 4,
      redaction_counts: { aadhaar: 1, pan: 1, email: 1, phone: 1 },
    });
  });

  it('redacts the same value every time it appears', () => {
    expect(redactText(`${EMAIL} and again ${EMAIL}`).text).toBe('[REDACTED:EMAIL] and again [REDACTED:EMAIL]');
  });
});

describe('evasion', () => {
  it('fullwidth digits and zero-width characters are normalized before matching', () => {
    const fullwidth = Array.from(PHONE.replace(/\D/g, ''), (d) => String.fromCodePoint(d.charCodeAt(0) + 0xfee0)).join(
      '',
    );
    expect(redactText(`call ${fullwidth}`).text).toBe('call [REDACTED:PHONE]');
    const zwsp = String.fromCodePoint(0x200b);
    const hidden = `${PAN.slice(0, 5)}${zwsp}${PAN.slice(5)}`;
    expect(redactText(`pan ${hidden}`).text).toBe('pan [REDACTED:PAN]');
    expect(normalize(`a${zwsp}b${String.fromCodePoint(0xfeff)}c`)).toBe('abc');
  });
});

describe('no PII in what leaves the module', () => {
  const canaries = [EMAIL, PHONE, PAN, AADHAAR, AADHAAR_SPACED, '98765 43210'];
  const text = `${EMAIL} | ${PHONE} | ${PAN} | ${AADHAAR_SPACED}`;

  it('findings and log fields hold offsets, kinds and counts only', () => {
    const r = redactText(text);
    const serialized = JSON.stringify([r.findings, redactionLogFields(r.findings), countFindings(r.findings)]);
    for (const c of canaries) expect(serialized, c).not.toContain(c);
    expect(Object.keys(r.findings[0] ?? {}).sort()).toEqual(['end', 'kind', 'start']);
  });

  it('the redacted text holds none of it either', () => {
    const r = redactText(text);
    for (const c of canaries) expect(r.text).not.toContain(c);
    expect(r.text).not.toMatch(/\d{5}/);
  });

  it('the module writes nothing to the console or stdout/stderr', () => {
    const spies = [
      vi.spyOn(console, 'log'),
      vi.spyOn(console, 'info'),
      vi.spyOn(console, 'warn'),
      vi.spyOn(console, 'error'),
      vi.spyOn(console, 'debug'),
      vi.spyOn(process.stdout, 'write'),
      vi.spyOn(process.stderr, 'write'),
    ];
    redactText(text);
    redactValue({ messages: [{ role: 'user', content: text }] });
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });
});

describe('redactValue', () => {
  it('redacts strings anywhere in JSON-shaped data and keeps the structure and keys', () => {
    const input = {
      messages: [{ role: 'user', content: `mail ${EMAIL}` }],
      args: { order: { note: `call ${PHONE}` }, amount_inr: 9000, ok: true, none: null },
      tags: [PAN, 'plain'],
    };
    const r = redactValue(input);
    expect(r.value).toEqual({
      messages: [{ role: 'user', content: 'mail [REDACTED:EMAIL]' }],
      args: { order: { note: 'call [REDACTED:PHONE]' }, amount_inr: 9000, ok: true, none: null },
      tags: ['[REDACTED:PAN]', 'plain'],
    });
    expect(countFindings(r.findings)).toEqual({ aadhaar: 0, pan: 1, email: 1, phone: 1 });
    expect(JSON.stringify(input)).toContain(EMAIL); // the input is not mutated
  });

  it('keeps a __proto__ key as plain data instead of polluting the result', () => {
    const r = redactValue(JSON.parse('{"__proto__": {"x": "mail a@b.example.test"}}'));
    expect(Object.getPrototypeOf(r.value)).toBe(Object.prototype);
    expect(JSON.stringify(r.value)).toBe('{"__proto__":{"x":"mail [REDACTED:EMAIL]"}}');
  });

  it('refuses a payload nested deeper than 32 levels', () => {
    let deep: unknown = 'x';
    for (let i = 0; i < 40; i += 1) deep = { a: deep };
    expect(() => redactValue(deep)).toThrow(RangeError);
  });
});

describe('speed on hostile input', () => {
  it('stays linear on long adversarial strings', () => {
    const big = 200_000;
    const cases = [
      '9'.repeat(big),
      '98765 '.repeat(big / 6),
      'a'.repeat(big),
      'a@'.repeat(big / 2),
      `${'a.'.repeat(big / 2)}@x`,
      '+1 '.repeat(big / 3),
      'ABCDE'.repeat(big / 5),
      '1 '.repeat(big / 2),
    ];
    for (const input of cases) {
      const t0 = performance.now();
      redactText(input);
      expect(performance.now() - t0, input.slice(0, 12)).toBeLessThan(1500);
    }
  });
});
