import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findViolations } from './check-wording.mjs';

const file = (path, text) => ({ path, text });

test('flags legal-compliance claims', () => {
  const v = findViolations(
    [
      file('a.tsx', 'Your org is compliant with the EU AI Act'),
      file('b.md', 'This app is non-compliant'),
      file('c.md', 'PRYSM guarantees compliance'),
      file('d.md', 'compliance-certified report'),
    ],
    [],
  );
  assert.deepEqual(
    v.map((x) => x.path),
    ['a.tsx', 'b.md', 'c.md', 'd.md'],
  );
});

test('allows control-status wording and unrelated words', () => {
  const v = findViolations(
    [file('a.md', 'Control status: passing. Evidence of logging enabled. OpenAI-compatible proxy. compliance team')],
    [],
  );
  assert.equal(v.length, 0);
});

test('allowlist is per file and per line', () => {
  const allow = [{ path: 'rule.md', contains: 'Never say "compliant"', reason: 'rule' }];
  const v = findViolations(
    [file('rule.md', 'Never say "compliant".\nWe are compliant.'), file('other.md', 'Never say "compliant".')],
    allow,
  );
  assert.deepEqual(
    v.map((x) => `${x.path}:${x.line}`),
    ['rule.md:2', 'other.md:1'],
  );
});
