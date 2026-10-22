import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // These suites run real Chromium and workerd alongside their unit cases.
    // Keep CPU contention bounded rather than retrying failed submissions.
    maxWorkers: 1,
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
});
