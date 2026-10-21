import { defineConfig } from "vitest/config";

// Unit tests for the editor's framework-free parts (the document store, the autopilot flow).
export default defineConfig({
  test: {
    include: ["components/**/*.test.ts", "lib/**/*.test.ts"],
  },
});
