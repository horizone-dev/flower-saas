import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // keep the exception filter's 4xx warn lines out of the test output
    env: { LOG_LEVEL: 'silent', NODE_ENV: 'test' },
    // integration tests spin Testcontainers — give them room, run files serially
    testTimeout: 30_000,
    hookTimeout: 240_000,
    fileParallelism: false,
  },
});
