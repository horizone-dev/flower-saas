// Isolated ESLint flat config for the negative-test fixture.
// Reproduces the monorepo's boundary model at small scale so the fixture files
// trigger real errors — proving `pnpm lint` has teeth.
import tseslint from 'typescript-eslint';
import flower from '../../src/eslint/plugin.js';

export default [
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    plugins: { flower },
    languageOptions: { parserOptions: { projectService: false } },
    rules: {
      'flower/dependency-boundaries': [
        'error',
        {
          default: 'disallow',
          // the fixture is its own tiny workspace: element paths are relative to this directory
          rootDir: import.meta.dirname,
          elements: [
            { type: 'pure', pattern: 'src/pure/**' },
            { type: 'app', pattern: 'src/app/**' },
          ],
          policies: [
            {
              from: { element: { type: 'pure' } },
              allow: { to: { element: { type: 'pure' } } },
            },
            {
              from: { element: { type: 'app' } },
              allow: { to: { element: { types: { anyOf: ['app', 'pure'] } } } },
            },
          ],
        },
      ],
      'flower/no-scope-from-request': 'error',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
];
