import { flowerConfig } from '@flower/config/eslint';

export default [
  ...flowerConfig({ type: 'lib', tsconfigRootDir: import.meta.dirname, enableBoundaries: false }),
  { ignores: ['dist/**'] },
];
