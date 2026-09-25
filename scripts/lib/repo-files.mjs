import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const BINARY = /\.(png|jpe?g|gif|ico|pdf|woff2?|zip|gz)$/i;
const SKIP = new Set(['LICENSE', 'pnpm-lock.yaml', 'uv.lock']);

/** Tracked plus untracked-but-not-ignored text files, as { path, text }. */
export function repoTextFiles(cwd = process.cwd()) {
  const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd, encoding: 'utf8' });
  return out
    .split('\0')
    .filter((p) => p && !BINARY.test(p) && !SKIP.has(p.split('/').pop() ?? ''))
    .flatMap((path) => {
      try {
        return [{ path, text: readFileSync(`${cwd}/${path}`, 'utf8') }];
      } catch {
        return []; // deleted in the working tree but still listed
      }
    });
}
