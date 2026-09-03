// Isolated ESLint flat config for the negative-test fixture.
// Reproduces the monorepo's boundary model at small scale so the fixture files
// trigger real errors — proving `pnpm lint` has teeth. Uses the v7 API.
import tseslint from 'typescript-eslint';
import boundaries from 'eslint-plugin-boundaries';
import flower from '../../src/eslint/plugin.js';

export default [
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    plugins: { boundaries, flower },
    languageOptions: { parserOptions: { projectService: false } },
    settings: {
      'import/resolver': { typescript: { project: './tsconfig.json' } },
      'boundaries/elements': [
        { type: 'pure', pattern: 'src/pure/**' },
        { type: 'app', pattern: 'src/app/**' },
      ],
    },
    rules: {
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
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
