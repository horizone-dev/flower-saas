import { defineConfig } from '@playwright/test';

/**
 * Super Admin Web smoke (PHASE-1-PLAN §1.11). Infra (Postgres + Redis) is
 * brought up by `e2e/run.mjs` (Testcontainers), which also migrates + seeds and
 * then execs `playwright test` with the connection env set. This config only
 * starts the two app processes and points the browser at the web app.
 */
const API_PORT = process.env['API_PORT'] ?? '3001';
const WEB_PORT = '3100';

const CI = !!process.env['CI'];

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  // one retry in CI — the smoke boots two servers + a full guard pipeline and
  // the runner's first cold pass can lose the webServer-ready race.
  retries: CI ? 1 : 0,
  timeout: 90_000,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'node ../../apps/api/dist/main.js',
      url: `http://localhost:${API_PORT}/healthz`,
      timeout: 120_000,
      reuseExistingServer: false,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        NODE_ENV: 'test',
        API_PORT,
        API_HOST: '127.0.0.1',
        DATABASE_URL: process.env['DATABASE_URL'] ?? '',
        PLATFORM_DATABASE_URL:
          process.env['PLATFORM_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? '',
        REDIS_URL: process.env['REDIS_URL'] ?? '',
        AUTH_JWT_SECRET: 'e2e-super-admin-smoke-jwt-secret-000000',
      },
    },
    {
      command: `pnpm exec next start -p ${WEB_PORT}`,
      url: `http://localhost:${WEB_PORT}/login`,
      timeout: 120_000,
      reuseExistingServer: false,
      env: {
        NODE_ENV: 'production',
        API_BASE_URL: `http://localhost:${API_PORT}`,
        NEXT_PUBLIC_API_BASE_URL: `http://localhost:${API_PORT}`,
      },
    },
  ],
});
