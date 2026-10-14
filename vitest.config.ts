import { defineConfig } from 'vitest/config';

// Test levels (DESIGN.md §15):
// - unit:    plain logic in Node            → tests/unit/**
// - browser: page-level code in Chromium    → tests/browser/**
export default defineConfig({
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
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/unit/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'browser',
          include: ['tests/browser/**/*.test.ts'],
          browser: {
            enabled: true,
            provider: 'playwright',
            headless: true,
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
});
