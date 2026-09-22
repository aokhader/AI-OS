import { defineConfig } from 'vitest/config';

// Unit tests only: no browser, no API key. Integration tests that drive the mock app
// through Playwright live under apps/runner/test and run with `pnpm test:integration` (P1+).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'apps/runner/test/**'],
  },
});
