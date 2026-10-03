/**
 * @flower/config ESLint plugin — the project-specific isolation and architecture rules.
 * Consumed by `@flower/config/eslint` and usable standalone.
 */
import noScopeFromRequest from './rules/no-scope-from-request.js';
import noRawPrismaInScopedModules from './rules/no-raw-prisma-in-scoped-modules.js';
import routeMustDeclarePermission from './rules/route-must-declare-permission.js';
import dependencyBoundaries from './rules/dependency-boundaries.js';

/** @type {import('eslint').ESLint.Plugin} */
const plugin = {
  meta: { name: 'flower', version: '0.0.0' },
  rules: {
    'no-scope-from-request': noScopeFromRequest,
    'no-raw-prisma-in-scoped-modules': noRawPrismaInScopedModules,
    'route-must-declare-permission': routeMustDeclarePermission,
    'dependency-boundaries': dependencyBoundaries,
  },
};

export default plugin;
export const rules = plugin.rules;
