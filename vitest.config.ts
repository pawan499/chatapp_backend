import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    testTimeout: 60000,
    hookTimeout: 120000,
    maxWorkers: 1,
    fileParallelism: false,
    include: ["tests/**/*.test.ts"],
  },
});
