import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/.next/**",
      "**/dist/**",
      "**/.turbo/**",
      "**/generated/**",
      "**/next-env.d.ts",
      "**/playwright-report/**",
      "**/test-results/**",
      ".tools/**",
      // Pre-existing scratch scripts, the standalone editor and the Remotion package are not part of the lint gate yet.
      "*.mjs",
      "apps/editor/**",
      "packages/render/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
