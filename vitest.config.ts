import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Match the "@/*" paths from tsconfig.json so route files import cleanly.
      '@': resolve(process.cwd()),
    },
  },
  test: {
    environment: 'node',
    coverage: {
      // Measure what ships: app + lib. Ops scripts and generated code are excluded.
      provider: 'v8',
      include: ['app/**/*.{ts,tsx}', 'lib/**/*.ts'],
      exclude: ['**/*.test.*', '**/*.d.ts'],
      // Baseline measured 2026-09-15: 37.8% lines overall (app is UI-heavy and
      // untested; lib is at 78%). Ratchet upward as component tests land:
      // target 50+ when app/page flows are covered.
      thresholds: {
        lines: 35,
        branches: 50,
        functions: 55,
        statements: 35,
      },
    },
  },
});
