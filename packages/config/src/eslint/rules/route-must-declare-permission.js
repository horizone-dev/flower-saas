/**
 * route-must-declare-permission
 *
 * CLAUDE.md rule 9 / ADR-0004: every controller route must declare an explicit
 * permission (`@RequirePermission(...)`) or be explicitly public (`@Public()`).
 * A route method with an HTTP-verb decorator and neither → error.
 *
 * Applies to classes decorated `@Controller(...)`. HTTP-verb decorators:
 * `@Get @Post @Put @Patch @Delete @Options @Head @All`.
 *
 * "Stub with teeth" — decorator-name heuristic (no type info needed).
 */

const HTTP_VERBS = new Set(['Get', 'Post', 'Put', 'Patch', 'Delete', 'Options', 'Head', 'All']);
const DEFAULT_PERMISSION_DECORATORS = ['RequirePermission', 'Permissions', 'RequirePermissions'];
const DEFAULT_PUBLIC_DECORATORS = ['Public', 'NoAuth', 'SkipAuth'];

function decoratorName(decorator) {
  const e = decorator.expression;
  if (e.type === 'CallExpression') {
    if (e.callee.type === 'Identifier') return e.callee.name;
    if (e.callee.type === 'MemberExpression' && e.callee.property.type === 'Identifier') {
      return e.callee.property.name;
    }
  }
  if (e.type === 'Identifier') return e.name;
  if (e.type === 'MemberExpression' && e.property.type === 'Identifier') return e.property.name;
  return null;
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Every controller route must declare @RequirePermission(...) or @Public(). See ADR-0004.',
      recommended: true,
    },
    schema: [
      {
        type: 'object',
        properties: {
          permissionDecorators: { type: 'array', items: { type: 'string' } },
          publicDecorators: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      missing:
        "Route '{{method}}' has an HTTP-verb decorator but no @{{perm}} or @{{pub}}. Every route declares a permission or is explicitly public. See ADR-0004.",
    },
  },

  create(context) {
    const opts = context.options[0] ?? {};
    const permDecos = new Set(opts.permissionDecorators ?? DEFAULT_PERMISSION_DECORATORS);
    const pubDecos = new Set(opts.publicDecorators ?? DEFAULT_PUBLIC_DECORATORS);

    function classDecorators(node) {
      return node.decorators ?? [];
    }

    function isController(classNode) {
      return classDecorators(classNode).some((d) => decoratorName(d) === 'Controller');
    }

    function checkMethod(memberNode) {
      const decos = memberNode.decorators ?? [];
      if (decos.length === 0) return;
      const names = decos.map(decoratorName).filter(Boolean);
      const hasVerb = names.some((n) => HTTP_VERBS.has(n));
      if (!hasVerb) return;
      const hasPerm = names.some((n) => permDecos.has(n));
      const hasPublic = names.some((n) => pubDecos.has(n));
      if (hasPerm || hasPublic) return;
      const methodName = memberNode.key.type === 'Identifier' ? memberNode.key.name : '<computed>';
      context.report({
        node: memberNode,
        messageId: 'missing',
        data: {
          method: methodName,
          perm: [...permDecos][0] ?? 'RequirePermission',
          pub: [...pubDecos][0] ?? 'Public',
        },
      });
    }

    function visitClass(node) {
      if (!isController(node)) return;
      for (const member of node.body.body) {
        if (member.type === 'MethodDefinition' && member.kind === 'method') checkMethod(member);
        if (
          member.type === 'PropertyDefinition' &&
          member.value?.type === 'ArrowFunctionExpression'
        ) {
          checkMethod(member);
        }
      }
    }

    return {
      ClassDeclaration: visitClass,
      ClassExpression: visitClass,
    };
  },
};
