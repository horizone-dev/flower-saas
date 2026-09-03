import { flowerConfig } from '@flower/config/eslint';

export default [
  ...flowerConfig({ type: 'next', tsconfigRootDir: import.meta.dirname, enableBoundaries: false }),
  { ignores: ['dist/**'] },
];
