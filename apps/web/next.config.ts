import type { NextConfig } from "next";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = dirname(fileURLToPath(import.meta.url));
const dev = process.env.NODE_ENV !== "production";

// Scripts only from this origin (Next's inline bootstrap needs 'unsafe-inline';
// dev's fast refresh needs eval). Media and network calls go to CloudFront,
// S3 (direct uploads), Pixabay previews and the editor's in-memory blob: copies.
// Nothing may frame the app, post forms elsewhere, or load plugins.
// Local stacks (Compose, kind, CI) serve media from MinIO over plain http on
// localhost; a browser only reaches those addresses on its own machine.
const local = "http://localhost:* http://127.0.0.1:*";
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'${dev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: https: ${local}`,
  `media-src 'self' data: blob: https: ${local}`,
  `connect-src 'self' blob: data: https: ${local}${dev ? " ws: http:" : ""}`,
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
];

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: join(appDir, "../.."),
  // Workspace packages ship TypeScript sources, so Next compiles them.
  transpilePackages: ["@reelwalk/core", "@reelwalk/db", "@reelwalk/render"],
  // Next's own "X-Powered-By: Next.js" says nothing a visitor needs.
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  // The person matte (ADR 0039) runs MediaPipe in the editor's preview. Its
  // WASM loader is a script, and script-src is 'self', so the runtime and the
  // model are served from this origin by rewrite rather than from the CDNs.
  async rewrites() {
    return [
      { source: "/mediapipe/wasm/:path*", destination: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.1/wasm/:path*" },
      { source: "/mediapipe/selfie_segmenter.tflite", destination: "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite" },
    ];
  },
};

export default nextConfig;
