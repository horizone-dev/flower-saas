import { defineConfig } from 'vitest/config';

/** The `e2e/` and `e2e-storefront/` suites are Playwright (`pnpm test:e2e`, `playwright.storefront.config.ts`), not Vitest — keep Vitest from picking up their `*.spec.ts`. */
export default defineConfig({
  // component tests render .tsx directly; the Next app build keeps its own JSX transform (tsconfig jsx: preserve)
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    exclude: ['e2e/**', 'e2e-storefront/**', 'node_modules/**', '.next/**', 'dist/**'],
  },
});
