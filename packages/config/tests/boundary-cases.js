// Shared fixtures for the dependency-boundary rule tests: a throwaway monorepo-shaped tree (real files, so import
// resolution is exercised for real) and the FROZEN expectation matrix.
//
// The matrix is a literal on purpose — it is the architecture contract, transcribed from the behaviour of the
// `eslint-plugin-boundaries` v7 `dependencies` rule that this repository used before it was replaced (the plugin
// pulled in a `micromatch` -> `braces` path with an unpatched advisory). It is NOT computed from BOUNDARY_POLICIES,
// so a regression in either the policy data or the rule shows up as a diff against this table.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** every "from" file lives next to a real sibling so a relative specifier can point at any target */
export const FROM = {
  'domain-module': 'apps/api/src/modules/orders/zz.ts',
  app: 'apps/api/src/common/zz.ts',
  'app (worker)': 'apps/worker/src/zz.ts',
  'pure (money)': 'packages/money/src/zz.ts',
  'pure (uom)': 'packages/uom/src/zz.ts',
  shared: 'packages/shared-types/src/zz.ts',
  'shared (permissions)': 'packages/permissions/src/zz.ts',
  ui: 'packages/ui/src/zz.ts',
  testing: 'packages/testing/src/zz.ts',
  db: 'packages/db/src/zz.ts',
  config: 'packages/config/src/zz.ts',
  'unclassified (backend)': 'packages/backend/src/zz.ts',
};

export const TO = {
  'same module': 'apps/api/src/modules/orders/order.service.ts',
  'other module': 'apps/api/src/modules/payments/available.ts',
  app: 'apps/api/src/common/audit.ts',
  'other app': 'apps/worker/src/main.ts',
  money: 'packages/money/src/index.ts',
  uom: 'packages/uom/src/index.ts',
  shared: 'packages/shared-types/src/index.ts',
  permissions: 'packages/permissions/src/index.ts',
  ui: 'packages/ui/src/index.ts',
  testing: 'packages/testing/src/index.ts',
  db: 'packages/db/src/index.ts',
  config: 'packages/config/src/index.ts',
  'unclassified (backend)': 'packages/backend/src/index.ts',
};

/**
 * One row per FROM, one character per TO column (the order of `TO`):
 *   V = a violation must be reported, . = the import is allowed.
 *
 *                                   same   other  app    other  money  uom    shared perms  ui     testing db    config unclassified
 *                                   module module        app
 */
export const EXPECTED = {
  'domain-module': '.VVV.....V.V.',
  app: '.............',
  'app (worker)': '.............',
  'pure (money)': 'VVVV..VVVVVV.',
  'pure (uom)': 'VVVV..VVVVVV.',
  shared: 'VVVV....VVVV.',
  'shared (permissions)': 'VVVV....VVVV.',
  ui: 'VVVV.....VVV.',
  testing: 'VVVV....V..V.',
  db: 'VVVV....VV.V.',
  config: 'VVVVVVVVVVV..',
  'unclassified (backend)': '.............',
};

/** workspace packages that exist in the tree (name -> dir) */
export const PACKAGES = {
  '@flower/money': 'packages/money',
  '@flower/uom': 'packages/uom',
  '@flower/shared-types': 'packages/shared-types',
  '@flower/permissions': 'packages/permissions',
  '@flower/ui': 'packages/ui',
  '@flower/testing': 'packages/testing',
  '@flower/db': 'packages/db',
  '@flower/config': 'packages/config',
  '@flower/backend': 'packages/backend',
};

/** `@flower/<name>` specifier -> the TO column it must be classified as */
export const SPECIFIER_TARGET = {
  '@flower/money': 'money',
  '@flower/uom': 'uom',
  '@flower/shared-types': 'shared',
  '@flower/permissions': 'permissions',
  '@flower/ui': 'ui',
  '@flower/testing': 'testing',
  '@flower/db': 'db',
  '@flower/config': 'config',
  '@flower/backend': 'unclassified (backend)',
};

export function expectedViolation(fromKey, toKey) {
  const i = Object.keys(TO).indexOf(toKey);
  const row = EXPECTED[fromKey];
  if (row === undefined || i < 0 || row.length !== Object.keys(TO).length) {
    throw new Error(`bad expectation row for ${fromKey}`);
  }
  return row[i] === 'V';
}

export function relativeSpecifier(fromFile, toFile, withJsExtension) {
  let rel = path.posix.relative(path.posix.dirname(fromFile), toFile);
  rel = rel.replace(/\.tsx?$/, withJsExtension ? '.js' : '');
  return rel.startsWith('.') ? rel : `./${rel}`;
}

/** Builds the throwaway tree in the OS temp dir and returns its root. `junctions` adds node_modules links. */
export function makeTree({ junctions = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flower-boundary-'));
  const put = (rel, text = 'export const x = 1;\n') => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  };
  put('pnpm-workspace.yaml', "packages:\n  - 'apps/*'\n  - 'packages/*'\n");
  put(
    'tsconfig.json',
    JSON.stringify({
      compilerOptions: {
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        target: 'ES2023',
        strict: true,
      },
    }),
  );
  for (const rel of Object.values(TO)) put(rel);
  for (const [name, dir] of Object.entries(PACKAGES)) {
    put(
      `${dir}/package.json`,
      JSON.stringify({ name, version: '0.0.0', main: './src/index.ts', types: './src/index.ts' }),
    );
    put(`${dir}/src/index.ts`);
  }
  put('apps/api/package.json', JSON.stringify({ name: '@flower/api', version: '0.0.0' }));
  put('apps/worker/package.json', JSON.stringify({ name: '@flower/worker', version: '0.0.0' }));
  put('apps/api/src/modules/orders/sibling.ts');
  put('apps/api/src/modules/orders/nested/deep.ts');
  put('packages/db/src/zz-target.ts');
  if (junctions) {
    for (const [name, dir] of Object.entries(PACKAGES)) {
      const link = path.join(root, 'node_modules', name);
      fs.mkdirSync(path.dirname(link), { recursive: true });
      fs.symlinkSync(path.join(root, dir), link, 'junction');
    }
  }
  return root;
}

export function removeTree(root) {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
}

/** import-statement shapes. `flagged` = the rule must see the dependency (parity with the previous rule). */
export const KINDS = [
  ['import declaration', (s) => `import { X } from '${s}';\nexport { X };\n`, true],
  ['import type', (s) => `import type { X } from '${s}';\nexport type Y = X;\n`, true],
  ['inline type import', (s) => `import { type X } from '${s}';\nexport type Y = X;\n`, true],
  ['side-effect import', (s) => `import '${s}';\n`, true],
  ['export named from', (s) => `export { X } from '${s}';\n`, true],
  ['export star from', (s) => `export * from '${s}';\n`, true],
  ['export type from', (s) => `export type { X } from '${s}';\n`, true],
  ['dynamic import (literal)', (s) => `export const f = () => import('${s}');\n`, true],
  ['require (literal)', (s) => `const x = require('${s}');\nexport { x };\n`, true],
  ['import = require', (s) => `import x = require('${s}');\nexport { x };\n`, false],
  [
    'dynamic import (template)',
    (s) => 'export const f = (n: string) => import(`' + s + '/${n}`);\n',
    false,
  ],
  [
    'call that merely mentions a module',
    (s) => `declare const vi: any;\nvi.mock('${s}');\n`,
    false,
  ],
];
