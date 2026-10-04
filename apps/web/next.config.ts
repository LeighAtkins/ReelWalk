import type { NextConfig } from "next";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: join(appDir, "../.."),
  // Workspace packages ship TypeScript sources, so Next compiles them.
  transpilePackages: ["@reelwalk/core", "@reelwalk/db"],
};

export default nextConfig;
