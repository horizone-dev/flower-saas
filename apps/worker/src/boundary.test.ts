import { describe, it, expect } from 'vitest';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkForbiddenImports, extractImportSpecifiers } from '@flower/testing';

/**
 * `apps/worker` architecture boundary (FC-3 / OD-P2-8 / HG-BOUNDARY): it must
 * never depend on `apps/api`'s HTTP controllers, Fastify request logic, or any
 * transport-specific module — it is a separate process that reuses domain logic
 * only through `@flower/backend`.
 *
 * See `packages/backend/src/boundary.test.ts` for why this is a direct disk
 * scan rather than an `eslint-plugin-boundaries` rule.
 */
const HERE = dirname(fileURLToPath(import.meta.url));

const FORBIDDEN: readonly RegExp[] = [
  /(^|\/)apps\/api\//,
  /^@flower\/api(\/|$)/,
  /^fastify$/,
  /^@fastify\//,
  /@nestjs\/platform-fastify/,
  /@nestjs\/swagger/,
  /controller/i,
];

describe('apps/worker architecture boundary (FC-3)', () => {
  it('the checker actually flags a forbidden import (teeth)', () => {
    const bad = [
      "import { UserController } from '../../../apps/api/src/modules/identity/user.controller.js';",
      "import { FastifyAdapter } from '@nestjs/platform-fastify';",
    ].join('\n');
    const hits = extractImportSpecifiers(bad).filter((h) =>
      FORBIDDEN.some((re) => re.test(h.specifier)),
    );
    expect(hits).toHaveLength(2);
  });

  it('the real worker source tree has zero forbidden imports', () => {
    const violations = checkForbiddenImports(HERE, FORBIDDEN, {
      excludeFiles: [/\.test\.ts$/],
    });
    expect(violations).toEqual([]);
  });
});
