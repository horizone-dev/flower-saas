import { describe, it, expect } from 'vitest';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkForbiddenImports, extractImportSpecifiers } from '@flower/testing';

/**
 * `@flower/backend` architecture boundary (FC-3 / HG-BOUNDARY):
 *   - it never imports from any `apps/*` runtime
 *   - it carries no HTTP / Fastify / transport code (that stays in `apps/api`)
 *
 * `eslint-plugin-boundaries` cannot see across package directories the way this
 * repo runs lint (`turbo run lint` runs one `eslint .` per package, each with
 * its own cwd — a glob like `apps/api/**` never resolves from inside
 * `packages/backend/`). This test instead scans the real compiled source tree
 * directly (`@flower/testing`'s `checkForbiddenImports`), so it proves the
 * actual boundary rather than a synthetic reproduction of it.
 */
const HERE = dirname(fileURLToPath(import.meta.url));

const FORBIDDEN: readonly RegExp[] = [
  /(^|\/)apps\//, // no apps/* runtime, anywhere in the specifier
  /^@flower\/(api|worker|scheduler|realtime)(\/|$)/,
  /^fastify$/,
  /^@fastify\//,
  /@nestjs\/platform-fastify/,
  /@nestjs\/swagger/,
  /^@nestjs\/core$/, // NestFactory / HTTP bootstrap — @flower/backend is DI-only, no runtime
  /^cookie$/,
  /\bcors\b/i,
];

describe('@flower/backend architecture boundary (FC-3)', () => {
  it('the checker actually flags a forbidden import (teeth)', () => {
    const bad = [
      "import { AppModule } from '../../../apps/api/src/app.module.js';",
      "import fastify from 'fastify';",
      "import { NestFactory } from '@nestjs/core';",
      "import { DocumentBuilder } from '@nestjs/swagger';",
    ].join('\n');
    const hits = extractImportSpecifiers(bad).filter((h) =>
      FORBIDDEN.some((re) => re.test(h.specifier)),
    );
    expect(hits.map((h) => h.specifier)).toEqual([
      '../../../apps/api/src/app.module.js',
      'fastify',
      '@nestjs/core',
      '@nestjs/swagger',
    ]);
  });

  it('the real @flower/backend source tree has zero forbidden imports', () => {
    const violations = checkForbiddenImports(HERE, FORBIDDEN, {
      excludeFiles: [/\.test\.ts$/],
    });
    expect(violations).toEqual([]);
  });
});
