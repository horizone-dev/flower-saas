import { defineConfig } from 'vitest/config';

/** The `e2e/` suite is Playwright (`pnpm test:e2e`), not Vitest — keep Vitest
 *  from picking up `e2e/*.spec.ts`. */
export default defineConfig({
  test: {
    exclude: ['e2e/**', 'node_modules/**', '.next/**', 'dist/**'],
  },
});
