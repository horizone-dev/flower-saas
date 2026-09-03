/**
 * @flower/config/prettier — shared Prettier config.
 * Kept in sync with the repo-root `.prettierrc.json`.
 *
 * Usage in a workspace `prettier.config.js`:
 *   export { default } from '@flower/config/prettier';
 */

/** @type {import('prettier').Config} */
const config = {
  printWidth: 100,
  singleQuote: true,
  semi: true,
  trailingComma: 'all',
  arrowParens: 'always',
  endOfLine: 'lf',
  overrides: [{ files: ['*.md', '*.yml', '*.yaml'], options: { printWidth: 80 } }],
};

export default config;
