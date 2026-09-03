import { flowerConfig } from '@flower/config/eslint';

export default [
  { ignores: ['dist/**', 'generated/**', 'prisma/migrations/**'] },
  ...flowerConfig({ type: 'lib', tsconfigRootDir: import.meta.dirname, enableBoundaries: false }),
];
