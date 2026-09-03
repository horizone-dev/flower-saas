import js from '@eslint/js';
import globals from 'globals';
import prettier from 'eslint-config-prettier';

// The repo dev/verification scripts are plain Node ESM (.mjs) + Bash — no
// TypeScript. This config is deliberately standalone (no typescript-eslint /
// projectService, which needs a tsconfig and misbehaves when a single `eslint`
// run spans multiple package roots, as the pre-commit hook does).
export default [
  { ignores: ['**/*.sh', '**/node_modules/**'] },
  js.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      sourceType: 'module',
      ecmaVersion: 2024,
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  prettier,
];
