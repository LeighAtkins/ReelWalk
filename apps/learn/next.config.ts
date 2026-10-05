import type { NextConfig } from "next";

// Static export, served from GitHub Pages at /<repo>/ (BASE_PATH set by the deploy script).
const basePath = process.env.BASE_PATH ?? "";

const nextConfig: NextConfig = {
  output: "export",
  basePath,
  trailingSlash: true,
  images: { unoptimized: true },
  env: { NEXT_PUBLIC_BASE_PATH: basePath },
};

export default nextConfig;
