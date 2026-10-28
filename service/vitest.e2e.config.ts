import { defineConfig } from 'vitest/config';

/** Tests that drive the real Microsoft Edge. They skip themselves when Edge is not installed. */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/e2e/**/*.test.ts'],
    testTimeout: 90_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
