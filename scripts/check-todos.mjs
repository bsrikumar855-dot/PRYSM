// Principle 8: every TODO/FIXME/HACK/XXX in code must be TODO(T-###) with T-### registered in docs/TRACKING.md §4.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { repoTextFiles } from './lib/repo-files.mjs';

const CODE = /\.(m?[jt]sx?|py|go|sh|ya?ml|toml|sql)$|(^|\/)Dockerfile[^/]*$|\.Dockerfile$/;
const MARKER = /\b(TODO|FIXME|HACK|XXX)\b(\((T-\d+)\))?/g;

/** IDs registered in the TRACKING.md TODO table (rows starting with "| T-123 |"). */
export function registeredIds(trackingText) {
  return new Set([...trackingText.matchAll(/^\|\s*(T-\d+)\s*\|/gm)].map((m) => m[1]));
}

/** Returns violations as { path, line, text, problem }. */
export function findViolations(files, ids) {
  const violations = [];
  for (const { path, text } of files) {
    if (!CODE.test(path)) continue;
    text.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(MARKER)) {
        const id = m[3];
        const problem = !id
          ? `${m[1]} without a (T-###) id`
          : !ids.has(id)
            ? `${id} not registered in TRACKING.md §4`
            : null;
        if (problem) violations.push({ path, line: i + 1, text: line.trim(), problem });
      }
    });
  }
  return violations;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const ids = registeredIds(readFileSync('docs/TRACKING.md', 'utf8'));
  const files = repoTextFiles().filter((f) => !f.path.startsWith('scripts/check-todos'));
  const violations = findViolations(files, ids);
  for (const v of violations) console.error(`${v.path}:${v.line}: ${v.problem}: ${v.text}`);
  if (violations.length) process.exit(1);
  console.log(`todo check ok (${ids.size} registered)`);
}
