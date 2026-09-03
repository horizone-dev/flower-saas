import { flowerConfig } from '@flower/config/eslint';

export default [
  ...flowerConfig({ type: 'node', tsconfigRootDir: import.meta.dirname, enableBoundaries: false }),
  { ignores: ['dist/**'] },
];
