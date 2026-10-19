import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // These files share one Postgres and a shared AI budget row. Run them one at a time: in parallel, their
    // concurrency tests starved each other's connection pools ("Unable to start a transaction in the given time").
    fileParallelism: false,
    testTimeout: 15_000,
  },
});
