/**
 * @flower/config/eslint — shared flat-config factory for the Flower SaaS monorepo.
 *
 * Usage in a workspace `eslint.config.js`:
 *
 *   import { flowerConfig } from '@flower/config/eslint';
 *   export default flowerConfig({ tsconfigRootDir: import.meta.dirname, type: 'nest' });
 *
 * `type`:
 *   - 'node'  generic Node/TS library or service
 *   - 'nest'  apps/api | worker | scheduler | realtime — enables the isolation rules
 *   - 'next'  Next.js apps — browser globals
 *   - 'pure'  packages/money | packages/uom — forbids I/O and non-determinism
 *   - 'lib'   other shared packages
 */
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import boundaries from 'eslint-plugin-boundaries';
import prettier from 'eslint-config-prettier';
import flower from './plugin.js';

const IGNORES = [
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
  '**/.turbo/**',
  '**/coverage/**',
  '**/node_modules/**',
  '**/*.gen.ts',
  'packages/db/generated/**',
];

/**
 * eslint-plugin-boundaries v7 element model for the monorepo.
 * `domain-module` is nested inside `app`, so it must be listed first (more specific).
 */
const BOUNDARY_ELEMENTS = [
  { type: 'domain-module', pattern: 'apps/api/src/modules/*/**', capture: ['module'] },
  { type: 'app', pattern: 'apps/*/**', capture: ['app'] },
  { type: 'pure-pkg', pattern: 'packages/(money|uom)/**' },
  {
    type: 'shared-pkg',
    pattern: 'packages/(shared-types|permissions|api-client|realtime-client|i18n)/**',
  },
  { type: 'ui-pkg', pattern: 'packages/ui/**' },
  { type: 'testing-pkg', pattern: 'packages/testing/**' },
  { type: 'db-pkg', pattern: 'packages/db/**' },
  { type: 'config-pkg', pattern: 'packages/config/**' },
];

/**
 * Allowed import edges (v7 `policies`). Everything not listed is denied.
 * Note: a domain module may not import another domain module directly — only via
 * its exported service interface / a domain event (that finer rule lands in Phase 1
 * once modules exist; here we forbid cross-module imports outright).
 */
const BOUNDARY_POLICIES = [
  { from: { element: { type: 'pure-pkg' } }, allow: { to: { element: { type: 'pure-pkg' } } } },
  {
    from: { element: { type: 'shared-pkg' } },
    allow: { to: { element: { types: { anyOf: ['shared-pkg', 'pure-pkg'] } } } },
  },
  {
    from: { element: { type: 'ui-pkg' } },
    allow: { to: { element: { types: { anyOf: ['ui-pkg', 'shared-pkg', 'pure-pkg'] } } } },
  },
  {
    from: { element: { type: 'db-pkg' } },
    allow: { to: { element: { types: { anyOf: ['db-pkg', 'shared-pkg', 'pure-pkg'] } } } },
  },
  {
    from: { element: { type: 'testing-pkg' } },
    allow: {
      to: { element: { types: { anyOf: ['testing-pkg', 'shared-pkg', 'pure-pkg', 'db-pkg'] } } },
    },
  },
  { from: { element: { type: 'config-pkg' } }, allow: { to: { element: { type: 'config-pkg' } } } },
  {
    from: { element: { type: 'domain-module' } },
    allow: {
      to: { element: { types: { anyOf: ['shared-pkg', 'pure-pkg', 'db-pkg', 'ui-pkg'] } } },
    },
  },
  // A domain module may not import another domain module's files directly — cross-module
  // interaction is via the exported service interface / a domain event (Phase 1 enforces
  // the finer rule; here any cross-module folder import is denied by the default).
  {
    from: { element: { type: 'app' } },
    allow: {
      to: {
        element: {
          types: {
            anyOf: [
              'app',
              'domain-module',
              'shared-pkg',
              'pure-pkg',
              'ui-pkg',
              'db-pkg',
              'testing-pkg',
              'config-pkg',
            ],
          },
        },
      },
    },
  },
];

export function flowerConfig(options = {}) {
  const {
    tsconfigRootDir = process.cwd(),
    type = 'node',
    enableBoundaries = true,
    extraIgnores = [],
  } = options;

  const env = type === 'next' ? { ...globals.browser, ...globals.node } : { ...globals.node };

  /** @type {import('eslint').Linter.Config[]} */
  const config = [
    { ignores: [...IGNORES, ...extraIgnores] },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
      files: ['**/*.{ts,tsx,mts,cts}'],
      languageOptions: {
        parserOptions: { projectService: true, tsconfigRootDir },
        globals: env,
      },
      plugins: { flower },
      rules: {
        '@typescript-eslint/no-unused-vars': [
          'error',
          { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
        ],
        '@typescript-eslint/no-explicit-any': 'error',
        '@typescript-eslint/consistent-type-imports': 'error',
        'no-console': type === 'nest' || type === 'node' ? 'warn' : 'off',
      },
    },
  ];

  if (type === 'nest') {
    config.push({
      files: ['**/*.ts'],
      plugins: { flower },
      rules: {
        'flower/no-scope-from-request': 'error',
        'flower/no-raw-prisma-in-scoped-modules': 'error',
        'flower/route-must-declare-permission': 'error',
      },
    });
  }

  if (type === 'pure') {
    config.push({
      files: ['src/**/*.ts'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            paths: [
              { name: 'fs', message: 'pure package: no I/O' },
              { name: 'node:fs', message: 'pure package: no I/O' },
              { name: 'crypto', message: 'pure package: no non-determinism' },
              { name: 'node:crypto', message: 'pure package: no non-determinism' },
            ],
            patterns: ['@flower/db', '@prisma/*', '**/prisma/*'],
          },
        ],
        'no-restricted-globals': [
          'error',
          { name: 'Date', message: 'pure package: pass time in explicitly' },
          {
            name: 'Math',
            message: 'pure package: Math.random is banned; deterministic math only via allowlist',
          },
        ],
      },
    });
  }

  if (enableBoundaries) {
    config.push({
      files: ['apps/**/*.{ts,tsx}', 'packages/**/*.{ts,tsx}'],
      plugins: { boundaries },
      settings: {
        'boundaries/include': ['apps/**/*', 'packages/**/*'],
        'boundaries/elements': BOUNDARY_ELEMENTS,
      },
      rules: {
        'boundaries/dependencies': ['error', { default: 'disallow', policies: BOUNDARY_POLICIES }],
        'boundaries/no-unknown': 'off',
        'boundaries/no-private': 'off',
      },
    });
  }

  config.push(prettier);
  return config;
}

export default flowerConfig;
export { BOUNDARY_ELEMENTS, BOUNDARY_POLICIES };
