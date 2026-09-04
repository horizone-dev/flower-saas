import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: { LOG_LEVEL: 'silent', NODE_ENV: 'test' },
    testTimeout: 30_000,
    hookTimeout: 240_000,
    fileParallelism: false,
  },
});
