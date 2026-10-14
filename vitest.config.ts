import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

// Test levels (DESIGN.md §15):
// - unit:    plain logic in Node            → tests/unit/**
// - browser: page-level code in Chromium    → tests/browser/**
// Projects inherit the root options (Vitest 5 default).
export default defineConfig({
  // Same build-time flag as build.ts; tests run as a dev build.
  define: { __DEV__: 'true' },
  test: {
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      thresholds: {
        'src/scanner/**': { lines: 80, branches: 80 },
        'src/shared/**': { lines: 80, branches: 80 },
      },
    },
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/unit/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'browser',
          include: ['tests/browser/**/*.test.ts'],
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
});
