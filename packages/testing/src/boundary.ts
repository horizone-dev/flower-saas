import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A dependency-free source-import scanner for architecture-boundary tests
 * (FC-3 / HG-BOUNDARY). `eslint-plugin-boundaries` cannot see across package
 * directories the way this repo runs lint (`turbo run lint` = one `eslint .`
 * per package, each with its own cwd) — cross-package glob patterns like
 * `apps/api/**` simply do not resolve from inside `packages/backend/`. This
 * scanner instead walks a real source tree directly off disk and inspects every
 * `import … from '…'` / `export … from '…'` / `require('…')` specifier, so a
 * package can assert facts about its own compiled boundary regardless of which
 * directory the test runner's `cwd` happens to be.
 */

export interface ImportHit {
  readonly file: string;
  readonly line: number;
  readonly specifier: string;
}

const IMPORT_RE = /(?:from\s+|require\(\s*)['"]([^'"]+)['"]/g;

/** Every import/require specifier in `source`, with its 1-based line number. */
export function extractImportSpecifiers(source: string): ImportHit[] {
  const hits: ImportHit[] = [];
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    for (const m of line.matchAll(IMPORT_RE)) {
      hits.push({ file: '', line: i + 1, specifier: m[1]! });
    }
  }
  return hits;
}

export interface ListSourceFilesOptions {
  /** file-relative-path regexes to skip (e.g. /\.test\.ts$/) */
  readonly excludeFiles?: readonly RegExp[];
  /** directory basenames to never descend into (default: node_modules, dist, .turbo) */
  readonly excludeDirs?: readonly string[];
  readonly extensions?: readonly string[];
}

const DEFAULT_EXCLUDE_DIRS = ['node_modules', 'dist', '.turbo', 'coverage', 'generated'];

/** Recursively list every source file under `dir` matching `extensions`. */
export function listSourceFiles(dir: string, opts: ListSourceFilesOptions = {}): string[] {
  const excludeDirs = new Set(opts.excludeDirs ?? DEFAULT_EXCLUDE_DIRS);
  const extensions = opts.extensions ?? ['.ts', '.tsx'];
  const out: string[] = [];

  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      if (excludeDirs.has(entry)) continue;
      const full = join(current, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
        continue;
      }
      if (!extensions.some((ext) => entry.endsWith(ext))) continue;
      if (opts.excludeFiles?.some((re) => re.test(full))) continue;
      out.push(full);
    }
  };
  walk(dir);
  return out;
}

/**
 * Scan every source file under `dir` and return every import whose specifier
 * matches one of `forbidden`. An empty result means the tree is clean.
 */
export function checkForbiddenImports(
  dir: string,
  forbidden: readonly RegExp[],
  opts: ListSourceFilesOptions = {},
): ImportHit[] {
  const violations: ImportHit[] = [];
  for (const file of listSourceFiles(dir, opts)) {
    const source = readFileSync(file, 'utf8');
    for (const hit of extractImportSpecifiers(source)) {
      if (forbidden.some((re) => re.test(hit.specifier))) {
        violations.push({ ...hit, file });
      }
    }
  }
  return violations;
}
