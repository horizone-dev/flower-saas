import { flowerConfig } from '@flower/config/eslint';

export default [
  { ignores: ['.next/**', 'next-env.d.ts'] },
  ...flowerConfig({ type: 'next', tsconfigRootDir: import.meta.dirname, enableBoundaries: false }),
];
