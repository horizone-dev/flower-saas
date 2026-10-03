import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { flowerConfig, boundaryConfigBlock } from '../src/eslint/index.js';
import { compilePattern, matchPattern } from '../src/eslint/rules/dependency-boundaries.js';
import {
  FROM,
  TO,
  KINDS,
  SPECIFIER_TARGET,
  expectedViolation,
  makeTree,
  removeTree,
  relativeSpecifier,
} from './boundary-cases.js';

const RULE_ID = 'flower/dependency-boundaries';

/** ESLint over a throwaway tree, using the SHIPPED boundary config block (no process.chdir: the rule must not
 *  depend on the working directory) */
function lintFor(root) {
  return new ESLint({
    cwd: root,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ['**/*.{ts,tsx}'],
        languageOptions: { parser: tseslint.parser, parserOptions: { projectService: false } },
      },
      boundaryConfigBlock(),
    ],
  });
}

async function violations(eslint, root, file, code) {
  const [r] = await eslint.lintText(code, { filePath: path.join(root, file) });
  expect(r.messages.filter((m) => !m.ruleId)).toEqual([]); // no parse errors
  return r.messages.filter((m) => m.ruleId === RULE_ID);
}

describe('flower/dependency-boundaries — frozen architecture matrix', () => {
  let root = '';
  let eslint;
  beforeAll(() => {
    root = makeTree();
    eslint = lintFor(root);
  }, 60_000);
  afterAll(() => removeTree(root));

  for (const [fromKey, from] of Object.entries(FROM)) {
    for (const [toKey, to] of Object.entries(TO)) {
      for (const js of [false, true]) {
        it(`${fromKey} -> ${toKey}${js ? ' (.js specifier)' : ''}`, async () => {
          const spec = relativeSpecifier(from, to, js);
          const found = await violations(
            eslint,
            root,
            from,
            `import { x } from '${spec}';\nexport { x };\n`,
          );
          expect(found.length > 0).toBe(expectedViolation(fromKey, toKey));
        });
      }
    }
  }

  for (const [fromKey, from] of Object.entries(FROM)) {
    for (const [spec, toKey] of Object.entries(SPECIFIER_TARGET)) {
      it(`${fromKey} -> workspace package ${spec}`, async () => {
        const found = await violations(
          eslint,
          root,
          from,
          `import { x } from '${spec}';\nexport { x };\n`,
        );
        expect(found.length > 0).toBe(expectedViolation(fromKey, toKey));
      });
    }
  }

  it('every violation names the offending element types', async () => {
    const [m] = await violations(
      eslint,
      root,
      FROM['pure (money)'],
      `import { x } from '${relativeSpecifier(FROM['pure (money)'], TO.db, false)}';\nexport { x };\n`,
    );
    expect(m.message).toBe(
      'There is no policy allowing dependencies from elements of type "pure-pkg" to elements of type "db-pkg"',
    );
  });

  describe('import shapes', () => {
    for (const [name, make, flagged] of KINDS) {
      it(`${name} is ${flagged ? 'checked' : 'not checked'}`, async () => {
        const spec = relativeSpecifier(FROM['pure (money)'], TO.db, false);
        const found = await violations(eslint, root, FROM['pure (money)'], make(spec));
        expect(found.length > 0).toBe(flagged);
      });
    }

    it('reports each offending import in a file separately', async () => {
      const db = relativeSpecifier(FROM['pure (money)'], TO.db, false);
      const cfg = relativeSpecifier(FROM['pure (money)'], TO.config, false);
      const found = await violations(
        eslint,
        root,
        FROM['pure (money)'],
        `import { a } from '${db}';\nimport { b } from '${cfg}';\nimport { c } from './index';\nexport { a, b, c };\n`,
      );
      expect(found).toHaveLength(2);
    });
  });

  describe('specifier resolution', () => {
    const from = FROM['pure (money)'];
    it('a directory specifier resolves to its index file', async () => {
      const code = `import { x } from '../../db/src';
export { x };
`;
      expect((await violations(eslint, root, from, code)).length).toBe(1);
    });
    it('a directory without an index file does not resolve (ignored)', async () => {
      fs.mkdirSync(path.join(root, 'packages/db/empty-dir'), { recursive: true });
      const code = `import { x } from '../../db/empty-dir';
export { x };
`;
      expect(await violations(eslint, root, from, code)).toEqual([]);
    });
    it('an explicit file extension resolves to that file', async () => {
      const code = `import { x } from '../../db/src/zz-target.ts';
export { x };
`;
      expect((await violations(eslint, root, from, code)).length).toBe(1);
    });
  });

  describe('what is deliberately ignored', () => {
    const from = FROM['domain-module'];
    it('node built-ins and third-party packages', async () => {
      expect(
        await violations(
          eslint,
          root,
          from,
          `import fs from 'node:fs';\nimport p from 'fastify';\nexport { fs, p };\n`,
        ),
      ).toEqual([]);
    });
    it('an INSTALLED third-party package, plain or pnpm-style symlinked, even though it sits under apps/', async () => {
      // plain: apps/api/node_modules/left-pad/package.json would classify as an "app" file without the guard
      const plain = path.join(root, 'apps/api/node_modules/left-pad');
      fs.mkdirSync(plain, { recursive: true });
      fs.writeFileSync(path.join(plain, 'package.json'), '{"name":"left-pad","version":"1.0.0"}');
      // pnpm-style: apps/api/node_modules/right-pad -> apps/api/node_modules/.pnpm/right-pad@1/node_modules/right-pad
      const store = path.join(
        root,
        'apps/api/node_modules/.pnpm/right-pad@1/node_modules/right-pad',
      );
      fs.mkdirSync(store, { recursive: true });
      fs.writeFileSync(path.join(store, 'package.json'), '{"name":"right-pad","version":"1.0.0"}');
      fs.symlinkSync(store, path.join(root, 'apps/api/node_modules/right-pad'), 'junction');
      const code = `import a from 'left-pad';
import b from 'right-pad';
export { a, b };
`;
      expect(await violations(eslint, root, from, code)).toEqual([]);
    });
    it('a relative import that does not resolve to a file', async () => {
      expect(
        await violations(
          eslint,
          root,
          from,
          `import { x } from '../../nowhere/missing';\nexport { x };\n`,
        ),
      ).toEqual([]);
    });
    it('imports inside the same module, including nested folders and parent-relative paths', async () => {
      const code = `import a from './sibling';\nimport b from './nested/deep';\nimport c from '../orders/order.service.js';\nexport { a, b, c };\n`;
      expect(await violations(eslint, root, from, code)).toEqual([]);
    });
    it('files outside apps/ and packages/', async () => {
      fs.mkdirSync(path.join(root, 'tooling'), { recursive: true });
      const code = `import { x } from '../${TO.db}';\nexport { x };\n`;
      expect(await violations(eslint, root, 'tooling/zz.ts', code)).toEqual([]);
    });
  });

  it('classifies a workspace package by node_modules lookup only for declared (linked) dependencies', async () => {
    const bare = makeTree({ junctions: false });
    try {
      const e = lintFor(bare);
      // no node_modules link -> the specifier does not resolve -> ignored (same as a missing dependency)
      expect(
        await violations(
          e,
          bare,
          FROM['pure (money)'],
          `import { x } from '@flower/db';\nexport { x };\n`,
        ),
      ).toEqual([]);
      // the same import with the link present is a violation
      expect(
        (
          await violations(
            eslint,
            root,
            FROM['pure (money)'],
            `import { x } from '@flower/db';\nexport { x };\n`,
          )
        ).length,
      ).toBe(1);
    } finally {
      removeTree(bare);
    }
  });

  it('works from any working directory and for a deeper nested tree root', async () => {
    const nested = makeTree();
    const cwd = process.cwd();
    try {
      process.chdir(os.tmpdir());
      const e = lintFor(nested);
      const spec = relativeSpecifier(FROM['pure (money)'], TO.db, false);
      expect(
        (
          await violations(
            e,
            nested,
            FROM['pure (money)'],
            `import { x } from '${spec}';\nexport { x };\n`,
          )
        ).length,
      ).toBe(1);
    } finally {
      process.chdir(cwd);
      removeTree(nested);
    }
  });
});

describe('flower/dependency-boundaries — configuration safety (fail closed)', () => {
  let root = '';
  beforeAll(() => {
    root = makeTree();
  });
  afterAll(() => removeTree(root));

  const run = async (ruleOptions) => {
    const eslint = new ESLint({
      cwd: root,
      overrideConfigFile: true,
      overrideConfig: [
        {
          files: ['**/*.ts'],
          languageOptions: { parser: tseslint.parser, parserOptions: { projectService: false } },
        },
        {
          files: ['**/*.ts'],
          plugins: { ...boundaryConfigBlock().plugins },
          rules: { [RULE_ID]: ['error', ruleOptions] },
        },
      ],
    });
    return eslint.lintText(`import { x } from './index';\nexport { x };\n`, {
      filePath: path.join(root, 'packages/money/src/zz.ts'),
    });
  };
  const base = {
    include: ['packages/**/*'],
    elements: [{ type: 'a', pattern: 'packages/money/**' }],
    policies: [{ from: { element: { type: 'a' } }, allow: { to: { element: { type: 'a' } } } }],
  };

  it('accepts a well-formed model', async () => {
    const [r] = await run(base);
    expect(r.messages).toEqual([]);
  });
  it('rejects an unsupported default (only "disallow" exists)', async () => {
    await expect(run({ ...base, default: 'allow' })).rejects.toThrow();
  });
  it('rejects a policy shape it does not understand instead of silently allowing', async () => {
    await expect(
      run({
        ...base,
        policies: [
          { from: { element: { type: 'a' } }, allow: { to: { element: { category: 'x' } } } },
        ],
      }),
    ).rejects.toThrow();
  });
  it('rejects a policy that references an element type the model does not define', async () => {
    await expect(
      run({
        ...base,
        policies: [
          { from: { element: { type: 'nope' } }, allow: { to: { element: { type: 'a' } } } },
        ],
      }),
    ).rejects.toThrow(/unknown element type "nope"/);
  });
  it('rejects an element pattern using glob syntax the matcher does not implement', async () => {
    await expect(
      run({ ...base, elements: [{ type: 'a', pattern: 'packages/{money,uom}/**' }] }),
    ).rejects.toThrow(/unsupported glob syntax/);
  });
  it('rejects a policy with no target element type', async () => {
    await expect(
      run({
        ...base,
        policies: [{ from: { element: { type: 'a' } }, allow: { to: { element: {} } } }],
      }),
    ).rejects.toThrow(/at least one target/);
  });
});

describe('flower/dependency-boundaries — include scoping', () => {
  let root = '';
  beforeAll(() => {
    root = makeTree();
  });
  afterAll(() => removeTree(root));

  const model = (include) => ({
    ...(include ? { include } : {}),
    elements: [
      { type: 'apps', pattern: 'apps/**/*' },
      { type: 'pkgs', pattern: 'packages/**/*' },
    ],
    policies: [
      { from: { element: { type: 'apps' } }, allow: { to: { element: { type: 'apps' } } } },
    ],
  });
  const lint = async (opts, file, spec) => {
    const eslint = new ESLint({
      cwd: root,
      overrideConfigFile: true,
      overrideConfig: [
        {
          files: ['**/*.ts'],
          languageOptions: { parser: tseslint.parser, parserOptions: { projectService: false } },
        },
        {
          files: ['**/*.ts'],
          plugins: { ...boundaryConfigBlock().plugins },
          rules: { [RULE_ID]: ['error', opts] },
        },
      ],
    });
    const [r] = await eslint.lintText(
      `import { x } from '${spec}';
export { x };
`,
      { filePath: path.join(root, file) },
    );
    return r.messages.filter((m) => m.ruleId === RULE_ID);
  };
  const toPackages = relativeSpecifier(
    'apps/api/src/common/zz.ts',
    'packages/db/src/index.ts',
    false,
  );

  it('without include, every classified file is checked', async () => {
    expect(await lint(model(), 'apps/api/src/common/zz.ts', toPackages)).toHaveLength(1);
  });
  it('a file outside include is not checked even though an element pattern would match it', async () => {
    expect(await lint(model(['packages/**/*']), 'apps/api/src/common/zz.ts', toPackages)).toEqual(
      [],
    );
  });
  it('a target outside include is not checked either', async () => {
    expect(await lint(model(['apps/**/*']), 'apps/api/src/common/zz.ts', toPackages)).toEqual([]);
  });
});

describe('pattern matcher', () => {
  const m = (pattern, file) => matchPattern(compilePattern(pattern), file);
  it('supports the glob subset the model uses: *, **, (a|b)', () => {
    expect(m('packages/(money|uom)/**', 'packages/money/src/a.ts')).toBeTruthy();
    expect(m('packages/(money|uom)/**', 'packages/uom/a.ts')).toBeTruthy();
    expect(m('packages/(money|uom)/**', 'packages/moneyx/a.ts')).toBeFalsy();
    expect(m('packages/(money|uom)/**', 'packages/db/a.ts')).toBeFalsy();
    expect(m('apps/*/**', 'apps/api/src/main.ts')).toBeTruthy();
    expect(m('apps/*/**', 'packages/api/src/main.ts')).toBeFalsy();
    expect(m('apps/**/*', 'apps/api/src/deep/er/main.ts')).toBeTruthy();
    expect(m('packages/ui/**', 'packages/ui/src/Button.tsx')).toBeTruthy();
    expect(m('packages/ui/**', 'packages/uix/src/Button.tsx')).toBeFalsy();
  });
  it('captures wildcard groups in order', () => {
    const hit = m('apps/api/src/modules/*/**', 'apps/api/src/modules/orders/order.service.ts');
    expect(hit?.captures[0]).toBe('orders');
    expect(m('apps/api/src/modules/*/**', 'apps/api/src/other/orders/a.ts')).toBeFalsy();
  });
  it('a trailing /** needs a file below the directory, so a file directly in modules/ is not a module member', () => {
    expect(m('apps/api/src/modules/*/**', 'apps/api/src/modules/README.md')).toBeFalsy();
    expect(m('apps/api/src/modules/*/**', 'apps/api/src/modules/orders/a.ts')).toBeTruthy();
    expect(m('apps/*/**', 'apps/x')).toBeFalsy();
  });
  it('does not let wildcards cross into dot-directories (glob default)', () => {
    expect(m('packages/ui/**', 'packages/ui/.storybook/main.ts')).toBeFalsy();
    expect(m('apps/**/*', 'apps/api/.next/server.ts')).toBeFalsy();
  });
  it('a wildcard SEGMENT does not match a leading-dot name either', () => {
    expect(m('apps/*/**', 'apps/.hidden/x.ts')).toBeFalsy();
    expect(m('packages/*/src/*', 'packages/ui/src/.hidden.ts')).toBeFalsy();
    expect(m('packages/*/src/*', 'packages/ui/src/visible.ts')).toBeTruthy();
  });
  it('treats regex metacharacters in a pattern literally', () => {
    expect(m('packages/a.b/**', 'packages/a.b/x.ts')).toBeTruthy();
    expect(m('packages/a.b/**', 'packages/aXb/x.ts')).toBeFalsy();
  });
  it('rejects pattern syntax it does not implement', () => {
    expect(() => compilePattern('packages/{a,b}/**')).toThrow(/unsupported/i);
    expect(() => compilePattern('packages/[ab]/**')).toThrow(/unsupported/i);
    expect(() => compilePattern('packages/!(a)/**')).toThrow(/unsupported/i);
  });
});

describe('factory wiring', () => {
  const block = (cfg) => cfg.find((b) => b.rules && b.rules[RULE_ID]);
  it('the shared factory enables the rule by default and honours enableBoundaries: false', () => {
    expect(block(flowerConfig({ type: 'lib' }))).toBeTruthy();
    expect(block(flowerConfig({ type: 'lib', enableBoundaries: false }))).toBeUndefined();
  });
  it('no boundaries/* rule, plugin or setting remains in the shared config', () => {
    const names = flowerConfig({ type: 'nest' }).flatMap((b) => [
      ...Object.keys(b.rules ?? {}),
      ...Object.keys(b.plugins ?? {}),
      ...Object.keys(b.settings ?? {}),
    ]);
    expect(names.filter((n) => n.startsWith('boundaries'))).toEqual([]);
    expect(names).toContain(RULE_ID);
  });
});
