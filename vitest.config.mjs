import { defineConfig } from 'vitest/config';

// Two projects so the VS Code Vitest extension (Test Explorer) shows both.
// Integration tests skip themselves unless DB2_REAL_TEST=true (see tests/integration/env.ts).
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          testTimeout: 300_000,
          hookTimeout: 300_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
