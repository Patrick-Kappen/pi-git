import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Hooks run inside git; its variables would point git calls in tests at this repository.
    env: { GIT_DIR: "", GIT_INDEX_FILE: "", GIT_WORK_TREE: "" },
    projects: [
      { test: { name: "unit", include: ["extensions/**/*.test.ts"] } },
      {
        test: {
          name: "integration",
          include: ["test/integration/**/*.test.ts"],
          // The integration tests change the working directory, which worker threads do not allow.
          pool: "forks",
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["extensions/**/*.ts"],
      exclude: ["**/*.test.ts"],
      reporter: ["text", "json-summary", "lcov"],
      thresholds: { lines: 95, functions: 95, branches: 90, statements: 95 },
    },
  },
});
