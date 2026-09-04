import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: { LOG_LEVEL: 'silent', NODE_ENV: 'test' },
    // the Redis-Testcontainers suite needs room to pull/start the container
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
