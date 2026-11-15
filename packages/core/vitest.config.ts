import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Budget per test (Vitest default: 5 s). The tests are deterministic, but a machine saturated by
    // an install and its antivirus scan was measured to slow every test uniformly, by up to 9 times
    // (docs/fr/qualite.md, Phase 1B.8). A hang still fails, after 30 s. Longer tests set their own.
    testTimeout: 30_000,
  },
});
