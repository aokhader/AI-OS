import { defineConfig } from 'vitest/config';

// Integration tests: real Chromium (headless) against the in-process mock app. No API key.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['apps/runner/test/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
