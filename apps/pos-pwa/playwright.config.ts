import { defineConfig } from '@playwright/test';

/**
 * POS pilot rehearsal (browser end to end). `e2e/run.mjs` starts PostgreSQL + Redis (Testcontainers), migrates, seeds a sale-ready shop with the
 * REAL application (real clock, real login), serves the API on :3001, builds the POS with `/v1` proxied to it, and then runs this suite in
 * Chromium against `next start`. Nothing in the sale path is stubbed: the browser talks to the real API and the real database.
 */
const WEB_PORT = '3300';
export const OWNER_PORT = '3400';
// E2E_FOCUS=credit (set by run.mjs): the memory-safe run — only the credit/advance spec, only the POS server (no Owner Web), a short per-test timeout.
const FOCUS = ['credit', 'pos', 'owner'].includes(process.env['E2E_FOCUS'] ?? '');
// E2E_FOCUS=owner: ONLY the Owner Web customer-credit journeys (they need the Owner Web server AND the POS server)
const FOCUS_OWNER = process.env['E2E_FOCUS'] === 'owner';
// E2E_FOCUS=pos additionally runs the pilot and VAT-guard journeys (all POS-only specs, still no Owner Web)
const FOCUS_POS = process.env['E2E_FOCUS'] === 'pos';

export default defineConfig({
  testDir: './e2e',
  testMatch: FOCUS
    ? FOCUS_OWNER
      ? '**/zzz-owner-credit.spec.ts'
      : FOCUS_POS
        ? ['**/pilot-sale.spec.ts', '**/y-vat-fail-closed.spec.ts', '**/zz-*.spec.ts']
        : '**/zz-*.spec.ts'
    : '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: FOCUS ? 60_000 : 120_000,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'retain-on-failure',
    viewport: { width: 1280, height: 800 },
  },
  webServer: [
    {
      command: `pnpm exec next start -p ${WEB_PORT}`,
      url: `http://localhost:${WEB_PORT}/login`,
      timeout: 120_000,
      reuseExistingServer: false,
      env: { NODE_ENV: 'production' },
    },
    ...(FOCUS && !FOCUS_OWNER
      ? []
      : [
          {
            // Owner Web (server components call the API directly from the server: API_BASE_URL)
            command: `pnpm --dir ../owner-web exec next start -p ${OWNER_PORT}`,
            url: `http://localhost:${OWNER_PORT}/login`,
            timeout: 120_000,
            reuseExistingServer: false,
            env: { NODE_ENV: 'production', API_BASE_URL: 'http://127.0.0.1:3001' },
          },
        ]),
  ],
});
