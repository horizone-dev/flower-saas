// Self-lint for @flower/config (plain ESM JS — does not use its own monorepo factory).
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['fixtures/**', 'node_modules/**', 'dist/**'] },
  js.configs.recommended,
  {
    files: ['**/*.{js,mjs}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': 'off',
    },
  },
];
