// Principle 7: PRYSM never claims a customer "is compliant". Fails on legal-compliance claims outside the allowlist.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { repoTextFiles } from './lib/repo-files.mjs';

export const PATTERNS = [
  /\b(non-?)?compliant\b/i,
  /\bcompliance[\s-]+certifi/i,
  /\bcertified\s+(for\s+)?compliance\b/i,
  /\b(guarantee[sd]?|ensures?|achieves?|achieving|proves?)\s+(full\s+)?compliance\b/i,
];

/**
 * Returns violations as { path, line, text }. An allowlist entry { path, contains, reason }
 * permits a matching line in that file if the line includes `contains`.
 */
export function findViolations(files, allowlist) {
  const violations = [];
  for (const { path, text } of files) {
    const allowed = allowlist.filter((a) => a.path === path);
    text.split('\n').forEach((line, i) => {
      if (!PATTERNS.some((p) => p.test(line))) return;
      if (allowed.some((a) => line.includes(a.contains))) return;
      violations.push({ path, line: i + 1, text: line.trim() });
    });
  }
  return violations;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const allowlist = JSON.parse(readFileSync(new URL('./wording-allowlist.json', import.meta.url), 'utf8'));
  const bad = allowlist.filter((a) => !a.reason);
  if (bad.length) throw new Error(`wording allowlist entries need a reason: ${JSON.stringify(bad)}`);
  const violations = findViolations(repoTextFiles(), allowlist);
  for (const v of violations) console.error(`${v.path}:${v.line}: legal-compliance claim: ${v.text}`);
  if (violations.length) {
    console.error(`\n${violations.length} wording violation(s). Use "control status" / "evidence of" (CLAUDE.md principle 7).`);
    process.exit(1);
  }
  console.log('wording check ok');
}
