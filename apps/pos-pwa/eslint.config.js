import { flowerConfig } from '@flower/config/eslint';

export default [
  // public/ holds static assets + the hand-written service worker (ServiceWorker
  // global scope, not part of the app bundle) — prettier formats it; eslint skips it.
  { ignores: ['.next/**', 'next-env.d.ts', 'public/**'] },
  ...flowerConfig({ type: 'next', tsconfigRootDir: import.meta.dirname, enableBoundaries: false }),
];
