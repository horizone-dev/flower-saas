/**
 * no-raw-prisma-in-scoped-modules
 *
 * CLAUDE.md rule 6 / ADR-0004: scoped domain modules must access data only through
 * `ScopedRepository` (which injects the tenant + branch filter). Raw Prisma /
 * `@flower/db` model access is forbidden inside scoped modules, except in files
 * explicitly allowed (typically `*.repository.ts`, migrations, seeds, the RLS spike).
 *
 * Flags, in files whose path matches `scopedPaths`:
 *   - `import { PrismaClient } from '@prisma/client'` / `from '@flower/db'`
 *   - `this.prisma.<model>.<op>(...)` and `prisma.<model>.<op>(...)`
 *
 * "Stub with teeth" — path + shape heuristic. Phase 1 replaces the client name
 * heuristic with a type check against the generated Prisma client.
 */

const DEFAULT_SCOPED = ['/modules/', '\\\\modules\\\\'];
const DEFAULT_ALLOW = [
  '\\.repository\\.ts$',
  '\\.repo\\.ts$',
  '/prisma/',
  '/db/',
  '/seed',
  'spike',
];
const PRISMA_SOURCES = new Set(['@prisma/client', '@flower/db', '@flower/db/client']);
const PRISMA_CLIENT_NAMES = new Set(['prisma', 'db', 'prismaClient', '_prisma']);

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow raw Prisma / @flower/db access in scoped domain modules; use ScopedRepository instead.',
      recommended: true,
    },
    schema: [
      {
        type: 'object',
        properties: {
          scopedPaths: { type: 'array', items: { type: 'string' } },
          allow: { type: 'array', items: { type: 'string' } },
          clientNames: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      rawImport:
        "Do not import Prisma directly ('{{source}}') in a scoped module. Go through ScopedRepository. See ADR-0004.",
      rawAccess:
        "Raw Prisma access ('{{expr}}') is not allowed in a scoped module. Use ScopedRepository so the tenant/branch filter is always applied. See ADR-0004.",
    },
  },

  create(context) {
    const opts = context.options[0] ?? {};
    const filename = context.filename ?? context.getFilename?.() ?? '';
    const norm = filename.replace(/\\/g, '/');

    const scopedPatterns = (opts.scopedPaths ?? DEFAULT_SCOPED).map((s) => new RegExp(s));
    const allowPatterns = (opts.allow ?? DEFAULT_ALLOW).map((s) => new RegExp(s));
    const clientNames = new Set([...PRISMA_CLIENT_NAMES, ...(opts.clientNames ?? [])]);

    const inScope =
      scopedPatterns.some((re) => re.test(norm)) && !allowPatterns.some((re) => re.test(norm));
    if (!inScope) return {};

    function isPrismaClientRef(node) {
      if (node.type === 'Identifier') return clientNames.has(node.name);
      if (
        node.type === 'MemberExpression' &&
        node.object.type === 'ThisExpression' &&
        node.property.type === 'Identifier'
      ) {
        return clientNames.has(node.property.name);
      }
      return false;
    }

    return {
      ImportDeclaration(node) {
        if (typeof node.source.value === 'string' && PRISMA_SOURCES.has(node.source.value)) {
          context.report({ node, messageId: 'rawImport', data: { source: node.source.value } });
        }
      },
      // this.prisma.order.findMany(...)  /  prisma.order.create(...)
      'CallExpression > MemberExpression.callee'(node) {
        // node = <...>.<op>  ; node.object should be <client>.<model>
        const model = node.object;
        if (model.type !== 'MemberExpression') return;
        if (!isPrismaClientRef(model.object)) return;
        context.report({
          node: model.object,
          messageId: 'rawAccess',
          data: { expr: context.sourceCode.getText(node.object) },
        });
      },
    };
  },
};
