import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Ignored recovery snapshots under tmp/ are artifacts, not test sources.
    include: ["test/**/*.test.ts"],
    // SQLite integration tests launch Python; unbounded parallelism causes
    // resource contention and spurious timeouts on developer machines.
    maxWorkers: 4,
  },
});
