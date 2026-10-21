import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Unit tests for the editor's framework-free parts (the document store, the autopilot flow), and
// server-rendered markup of a few sheets (the critic's findings in the Export sheet).
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: {
    include: ["components/**/*.test.ts", "lib/**/*.test.ts"],
  },
});
