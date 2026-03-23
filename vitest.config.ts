import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Unit tests only (fast)
    include: ['server/__tests__/unit/**/*.test.ts'],
    testTimeout: 30_000,
    reporters: ['verbose'],
    sequence: { concurrent: false },
  },
});
