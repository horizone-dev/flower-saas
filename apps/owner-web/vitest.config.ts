import { defineConfig } from 'vitest/config';

export default defineConfig({
  // component tests render .tsx directly; the Next app build keeps its own JSX transform (tsconfig jsx: preserve)
  oxc: { jsx: { runtime: 'automatic' } },
  resolve: { alias: { '@': new URL('./src', import.meta.url).pathname } },
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
});
