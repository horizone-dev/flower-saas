import { flowerConfig } from '@flower/config/eslint';

export default [
  ...flowerConfig({ type: 'pure', tsconfigRootDir: import.meta.dirname, enableBoundaries: false }),
  { ignores: ['dist/**'] },
];
