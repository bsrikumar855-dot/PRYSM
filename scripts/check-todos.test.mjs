import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findViolations, registeredIds } from './check-todos.mjs';

const tracking = '| ID | Location |\n|---|---|\n| T-001 | apps/api | x | M1 |\n';

test('reads registered ids from the TRACKING table', () => {
  assert.deepEqual([...registeredIds(tracking)], ['T-001']);
});

test('flags bare and unregistered markers in code only', () => {
  const ids = registeredIds(tracking);
  const v = findViolations(
    [
      { path: 'a.ts', text: '// TODO(T-001) ok\n// TODO fix\n// FIXME(T-999) later' },
      { path: 'b.py', text: '# HACK' },
      { path: 'notes.md', text: 'TODO in prose is fine' },
      { path: 'infra/node.Dockerfile', text: '# XXX' },
    ],
    ids,
  );
  assert.deepEqual(
    v.map((x) => `${x.path}:${x.line}`),
    ['a.ts:2', 'a.ts:3', 'b.py:1', 'infra/node.Dockerfile:1'],
  );
});
