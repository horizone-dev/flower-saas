import { defineConfig } from '@playwright/test';

/**
 * Browser checks against an ALREADY RUNNING staging stack over HTTPS (no local servers are started). Used for the Owner Web authenticator
 * enrolment spec: the session cookie must be HttpOnly + Secure on a real https origin.
 *
 *   E2E_CREDS_FILE=<json with slug + owner2{email,password}> OWNER_BASE_URL=https://<owner-host> \
 *     pnpm --filter @flower/pos-pwa exec playwright test -c playwright.staging.config.ts
 *
 * `ignoreHTTPSErrors` is for the LOCAL smoke (Caddy's internal CA); a real staging host with a public certificate does not need it.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: 'z2-owner-mfa-enrol.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  reporter: [['list']],
  use: { ignoreHTTPSErrors: true, trace: 'retain-on-failure' },
});
