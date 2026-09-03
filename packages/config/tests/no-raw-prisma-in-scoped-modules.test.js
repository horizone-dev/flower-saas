import rule from '../src/eslint/rules/no-raw-prisma-in-scoped-modules.js';
import { makeRuleTester } from './rule-tester.js';

const scoped = 'apps/api/src/modules/orders/orders.service.ts';
const repo = 'apps/api/src/modules/orders/orders.repository.ts';
const outside = 'apps/api/src/common/health/health.service.ts';

makeRuleTester().run('no-raw-prisma-in-scoped-modules', rule, {
  valid: [
    // scoped module using ScopedRepository — fine
    { code: 'class S { async find() { return this.repo.findMany(); } }', filename: scoped },
    // raw prisma is allowed in a *.repository.ts
    {
      code: "import { PrismaClient } from '@prisma/client'; const p = new PrismaClient();",
      filename: repo,
    },
    { code: 'class R { list() { return this.prisma.order.findMany(); } }', filename: repo },
    // raw prisma outside a scoped module path — this rule does not fire (other rules may)
    { code: 'class H { ping() { return this.prisma.$queryRaw`select 1`; } }', filename: outside },
  ],
  invalid: [
    {
      code: "import { PrismaClient } from '@prisma/client';",
      filename: scoped,
      errors: [{ messageId: 'rawImport' }],
    },
    {
      code: "import { db } from '@flower/db';",
      filename: scoped,
      errors: [{ messageId: 'rawImport' }],
    },
    {
      code: 'class S { list() { return this.prisma.order.findMany({ where: {} }); } }',
      filename: scoped,
      errors: [{ messageId: 'rawAccess' }],
    },
    {
      code: 'async function post(data) { return await prisma.journalEntry.create({ data }); }',
      filename: scoped,
      errors: [{ messageId: 'rawAccess' }],
    },
  ],
});
