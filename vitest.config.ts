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
  },
});
