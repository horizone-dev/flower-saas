import rule from '../src/eslint/rules/no-scope-from-request.js';
import { makeRuleTester } from './rule-tester.js';

makeRuleTester().run('no-scope-from-request', rule, {
  valid: [
    // scope from the session / request context is fine
    'const t = ctx.session.tenantId;',
    'const b = this.requestContext.branchId;',
    // a non-scope property off the body is fine
    'const name = req.body.customerName;',
    // scope-shaped name but not off a request bucket
    'const x = order.tenantId;',
    'const y = payload.tenant_id;',
  ],
  invalid: [
    {
      code: 'const t = req.body.tenantId;',
      errors: [{ messageId: 'scopeFromRequest' }],
    },
    {
      code: 'const b = request.params.branch_id;',
      errors: [{ messageId: 'scopeFromRequest' }],
    },
    {
      code: "const c = req.query['companyId'];",
      errors: [{ messageId: 'scopeFromRequest' }],
    },
    {
      code: "const h = request.headers['x-tenant-id'] ?? request.headers.tenantId;",
      errors: [{ messageId: 'scopeFromRequest' }],
    },
    {
      code: 'const { tenantId, branchId } = socket.handshake.query;',
      errors: [{ messageId: 'scopeFromRequest' }, { messageId: 'scopeFromRequest' }],
    },
  ],
});
