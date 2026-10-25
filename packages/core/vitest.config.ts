import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  // Tracking fixtures are CPU-heavy. Leave room for the other workspace suites
  // that Turbo runs alongside core, rather than timing out under contention.
  test: { maxWorkers: 2 },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("../../apps/web", import.meta.url)),
      "@reelwalk/db": fileURLToPath(new URL("../db/src/index.ts", import.meta.url)),
      "@reelwalk/core": fileURLToPath(new URL("./src/index.ts", import.meta.url)),
    },
  },
});
