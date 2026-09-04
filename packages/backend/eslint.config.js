import { flowerConfig } from '@flower/config/eslint';

export default [
  ...flowerConfig({ type: 'nest', tsconfigRootDir: import.meta.dirname, enableBoundaries: false }),
  { ignores: ['dist/**'] },
];
