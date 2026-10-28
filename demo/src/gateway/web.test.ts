import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The dashboard is one static page. These checks keep it compatible with the server's strict CSP (script-src 'self',
// no inline anything) and with the repo's wording rule.
const root = new URL('../../web/', import.meta.url);
const html = readFileSync(new URL('index.html', root), 'utf8');
const js = readFileSync(new URL('app.js', root), 'utf8');
const css = readFileSync(new URL('style.css', root), 'utf8');
const forbiddenWord = ['compli', 'ant'].join('');

describe('dashboard is CSP-safe', () => {
  it('has exactly one script, from the same origin, and no inline script, style or event handler', () => {
    const scripts = [...html.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0]);
    expect(scripts).toEqual(['<script src="/app.js">']);
    expect(html).not.toMatch(/<script\b(?![^>]*\bsrc=)[^>]*>/i);
    expect(html).not.toMatch(/<style\b/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/\sstyle\s*=/i);
    expect(html).not.toMatch(/javascript:/i);
  });

  it('loads only its own stylesheet and script, with no external hosts', () => {
    expect(html).toContain('href="/style.css"');
    for (const text of [html, js, css]) expect(text).not.toMatch(/https?:\/\/(?!127\.0\.0\.1|localhost)/i);
  });

  it('never builds markup from data: no innerHTML, eval, Function, document.write or insertAdjacentHTML', () => {
    for (const bad of [
      'innerHTML',
      'outerHTML',
      'eval(',
      'new Function',
      'document.write',
      'insertAdjacentHTML',
      'setTimeout("',
      "setTimeout('",
    ]) {
      expect(js, bad).not.toContain(bad);
    }
    expect(js).toContain('textContent');
  });

  it('sends its mutating requests with the custom header the server requires', () => {
    expect(js).toContain("'x-demo-action': '1'");
  });
});

describe('dashboard wording and labels', () => {
  it('says control status and evidence of, never the forbidden claim', () => {
    for (const text of [html, js, css]) expect(text.toLowerCase()).not.toContain(forbiddenWord);
    expect(html).toContain('Control status and evidence');
  });

  it('labels itself DEMO-ONLY and the tamper panel as such, and shows redaction counts, not values', () => {
    expect(html).toContain('DEMO-ONLY');
    expect(html).toMatch(/Tamper with the evidence \(DEMO-ONLY\)/);
    expect(js).toContain('Redacted before the model');
    expect(js).toContain('countsText');
  });

  it('has the four things the demo promises: feed, approval queue, chain badge and tamper buttons', () => {
    for (const id of ['feed', 'queue', 'badge', 'btn-edit', 'btn-rewrite', 'btn-delete', 'btn-verify', 'btn-reset']) {
      expect(html, id).toContain(`id="${id}"`);
    }
  });
});
