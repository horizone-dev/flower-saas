import { describe, it, expect } from 'vitest';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkForbiddenImports, extractImportSpecifiers } from '@flower/testing';

/**
 * `apps/realtime` architecture boundary (FC-3 / OD-P2-8, task 2.5): it may use
 * Fastify/WebSocket directly (it genuinely is an HTTP+WS transport, unlike
 * `apps/worker`/`apps/scheduler`) but must never depend on `apps/api`,
 * `apps/worker` or `apps/scheduler` directly, or on NestJS controller/HTTP
 * machinery it has no business touching — it reuses shared logic only through
 * `@flower/backend` (the session/auth primitive, task 2.5) and
 * `@flower/service-runtime`.
 *
 * See `packages/backend/src/boundary.test.ts` for why this is a direct disk
 * scan rather than an `eslint-plugin-boundaries` rule.
 */
const HERE = dirname(fileURLToPath(import.meta.url));

const FORBIDDEN: readonly RegExp[] = [
  /(^|\/)apps\/api\//,
  /(^|\/)apps\/worker\//,
  /(^|\/)apps\/scheduler\//,
  /^@flower\/api(\/|$)/,
  /^@flower\/worker(\/|$)/,
  /^@flower\/scheduler(\/|$)/,
  /@nestjs\/platform-fastify/,
  /@nestjs\/swagger/,
  /@nestjs\/core/,
  /controller/i,
];

describe('apps/realtime architecture boundary (FC-3)', () => {
  it('the checker actually flags a forbidden import (teeth)', () => {
    const bad = [
      "import { UserController } from '../../../apps/api/src/modules/identity/user.controller.js';",
      "import { OutboxDispatcher } from '../../../apps/worker/src/outbox/dispatcher.js';",
      "import { NestFactory } from '@nestjs/core';",
    ].join('\n');
    const hits = extractImportSpecifiers(bad).filter((h) =>
      FORBIDDEN.some((re) => re.test(h.specifier)),
    );
    expect(hits).toHaveLength(3);
  });

  it('the real realtime source tree has zero forbidden imports', () => {
    const violations = checkForbiddenImports(HERE, FORBIDDEN, {
      excludeFiles: [/\.test\.ts$/],
    });
    expect(violations).toEqual([]);
  });
});
