import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const source = (name: string) => fileURLToPath(new URL(`../${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against the workspace sources, so no prior build is required.
    alias: {
      '@geoplacer/core': source('core'),
      '@geoplacer/simulator': source('simulator'),
      '@geoplacer/adapters-node': source('adapters-node'),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Budget per test (Vitest default: 5 s): see packages/core/vitest.config.ts (Phase 1B.8).
    testTimeout: 30_000,
  },
});
