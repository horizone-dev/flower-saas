import { defineConfig } from '@playwright/test';

/**
 * CUSTOMER WEB storefront (browser, mobile viewport). The storefront reads only its in-memory DEMO catalog and calls no API, so this needs no database and
 * no other server: build `apps/customer-web` (`pnpm --dir ../customer-web exec next build`), then run
 *   pnpm exec playwright test -c playwright.storefront.config.ts
 * One worker, one `next start`.
 */
const PORT = '3500';

export default defineConfig({
  testDir: './e2e-storefront',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  },
  webServer: {
    command: `pnpm --dir ../customer-web exec next start -p ${PORT}`,
    url: `http://localhost:${PORT}/`,
    timeout: 120_000,
    reuseExistingServer: false,
    env: { NODE_ENV: 'production' },
  },
});
