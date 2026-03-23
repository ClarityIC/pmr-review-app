import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Integration tests only (slow — calls real GCP services)
    include: ['server/__tests__/integration/**/*.test.ts'],
    testTimeout: 30 * 60 * 1000,  // 30 minutes max per test
    hookTimeout: 60_000,
    reporters: ['verbose'],
    sequence: { concurrent: false },  // run sequentially to avoid GCP rate limits
  },
});
