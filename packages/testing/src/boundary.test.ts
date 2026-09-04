import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractImportSpecifiers, listSourceFiles, checkForbiddenImports } from './boundary.js';

describe('extractImportSpecifiers', () => {
  it('finds import / re-export / require specifiers with 1-based line numbers', () => {
    const src = [
      "import { Foo } from '@flower/db';",
      "export { Bar } from './bar.js';",
      "const x = require('fastify');",
      '// not an import at all',
    ].join('\n');
    const hits = extractImportSpecifiers(src);
    expect(hits.map((h) => h.specifier)).toEqual(['@flower/db', './bar.js', 'fastify']);
    expect(hits[0]!.line).toBe(1);
    expect(hits[2]!.line).toBe(3);
  });
});

describe('checkForbiddenImports (disk scan)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flower-boundary-test-'));

  it('flags a real file on disk whose specifier matches a forbidden pattern (teeth)', () => {
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(join(dir, 'sub', 'bad.ts'), "import fastify from 'fastify';\n");
    writeFileSync(join(dir, 'sub', 'good.ts'), "import { z } from 'zod';\n");

    const violations = checkForbiddenImports(dir, [/^fastify$/]);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.specifier).toBe('fastify');
    expect(violations[0]!.file).toMatch(/bad\.ts$/);

    rmSync(dir, { recursive: true, force: true });
  });
});

describe('listSourceFiles', () => {
  it('skips node_modules / dist and non-matching extensions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flower-boundary-list-'));
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'skip.ts'), '');
    writeFileSync(join(dir, 'dist', 'skip.ts'), '');
    writeFileSync(join(dir, 'keep.ts'), '');
    writeFileSync(join(dir, 'ignore.json'), '');

    const files = listSourceFiles(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/keep\.ts$/);

    rmSync(dir, { recursive: true, force: true });
  });
});
