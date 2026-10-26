import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      // Vendored agent skills (Remotion's examples): not our code, and not built.
      "**/.claude/**",
      "**/.next/**",
      "**/out/**",
      "**/dist/**",
      "**/.turbo/**",
      "**/generated/**",
      "**/next-env.d.ts",
      "**/playwright-report/**",
      "**/test-results/**",
      ".tools/**",
      // Pre-existing scratch scripts and the standalone editor are not part of the lint gate yet.
      "*.mjs",
      "apps/editor/**",
      "packages/render/scripts/*.mjs",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
