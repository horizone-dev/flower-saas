/**
 * no-scope-from-request
 *
 * CLAUDE.md rule 5 / ADR-0004: `tenant_id` / `branch_id` / `company_id` must come
 * ONLY from the authenticated session (the immutable RequestContext), never from a
 * request body / params / query / headers, and never from a realtime subscription
 * payload.
 *
 * This rule flags reads of a scope-shaped property off a request-like object's
 * `body` / `params` / `query` / `headers` (and direct destructuring of them).
 *
 * It is intentionally conservative (name + shape heuristic) — a "stub with teeth".
 * Phase 1 tightens it with type information once `RequestContext` exists.
 */

const SCOPE_PROP = /^(tenant|branch|company)_?id$/i;
const REQUEST_ROOTS = [
  'req',
  'request',
  'ctx',
  'context',
  'httpReq',
  'rawRequest',
  'socket',
  'client',
];
const REQUEST_BUCKET = new Set(['body', 'params', 'query', 'headers', 'raw', 'data', 'handshake']);

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow reading tenant_id / branch_id / company_id from a request body, params, query, headers or a realtime subscription payload. Scope comes only from the authenticated session.',
      recommended: true,
    },
    schema: [
      {
        type: 'object',
        properties: {
          extraRoots: { type: 'array', items: { type: 'string' } },
          extraScopeProps: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      scopeFromRequest:
        "Do not read '{{prop}}' from the request ('{{path}}'). tenant_id / branch_id / company_id come only from the authenticated session (RequestContext). See ADR-0004.",
    },
  },

  create(context) {
    const opts = context.options[0] ?? {};
    const roots = new Set([...REQUEST_ROOTS, ...(opts.extraRoots ?? [])]);
    const scopeProp = (name) =>
      SCOPE_PROP.test(name) || (opts.extraScopeProps ?? []).includes(name);

    /** root identifier name of a member chain, or null */
    function chainRoot(node) {
      let cur = node;
      while (cur && cur.type === 'MemberExpression') cur = cur.object;
      return cur && cur.type === 'Identifier' ? cur.name : null;
    }

    /** does this member chain pass through a request bucket (body/params/...)? */
    function passesThroughBucket(node) {
      let cur = node;
      while (cur && cur.type === 'MemberExpression') {
        const key =
          cur.property.type === 'Identifier'
            ? cur.property.name
            : cur.property.type === 'Literal'
              ? String(cur.property.value)
              : null;
        if (key && REQUEST_BUCKET.has(key)) return true;
        cur = cur.object;
      }
      return false;
    }

    function propName(node) {
      if (node.property.type === 'Identifier' && !node.computed) return node.property.name;
      if (node.property.type === 'Literal') return String(node.property.value);
      return null;
    }

    return {
      MemberExpression(node) {
        const name = propName(node);
        if (!name || !scopeProp(name)) return;
        const root = chainRoot(node);
        if (!root || !roots.has(root)) return;
        if (!passesThroughBucket(node)) return;
        context.report({
          node,
          messageId: 'scopeFromRequest',
          data: { prop: name, path: context.sourceCode.getText(node) },
        });
      },

      // const { tenantId } = req.body / request.params / socket.handshake.query ...
      'VariableDeclarator > ObjectPattern'(node) {
        const init = node.parent.init;
        if (!init || init.type !== 'MemberExpression') return;
        const root = chainRoot(init);
        if (!root || !roots.has(root) || !passesThroughBucket(init)) return;
        for (const p of node.properties) {
          if (p.type !== 'Property' || p.key.type !== 'Identifier') continue;
          if (scopeProp(p.key.name)) {
            context.report({
              node: p,
              messageId: 'scopeFromRequest',
              data: { prop: p.key.name, path: context.sourceCode.getText(init) },
            });
          }
        }
      },
    };
  },
};
