import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startTestStack, migrateTestDb } from '@flower/testing';
import { seedForSmoke } from './seed.mjs';

/**
 * Orchestrates the Super Admin smoke: Testcontainers Postgres + Redis, migrate,
 * seed the platform realm, then exec `playwright test` with the connection env
 * set (playwright.config.ts starts the api + web processes and runs the spec).
 */
const authFile = fileURLToPath(new URL('./.smoke-auth.json', import.meta.url));

const stack = await startTestStack({ services: ['postgres', 'redis'] });
try {
  migrateTestDb(stack.postgres.url);
  const creds = await seedForSmoke(stack.postgres.url);
  writeFileSync(authFile, JSON.stringify(creds, null, 2));

  const result = spawnSync('pnpm', ['exec', 'playwright', 'test'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      DATABASE_URL: stack.postgres.url,
      PLATFORM_DATABASE_URL: stack.postgres.url,
      REDIS_URL: stack.redis.url,
      API_PORT: '3001',
    },
  });
  process.exitCode = result.status ?? 1;
} finally {
  await stack.stop();
}
