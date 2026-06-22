## ── Stage 1: deps ─────────────────────────────────────────────
FROM node:22-alpine AS deps

WORKDIR /workspace
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile=false

## ── Stage 2: builder ──────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /workspace
RUN corepack enable

ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=deps /workspace/node_modules node_modules
COPY --from=deps /workspace/apps/web/node_modules apps/web/node_modules
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web apps/web

RUN pnpm --filter @reelwalk/web build

## ── Stage 3: prune ────────────────────────────────────────────
# Strip build-only packages from the standalone output to shrink
# the final image from ~260 MB to ~70 MB.
FROM node:22-alpine AS pruner

WORKDIR /workspace
COPY --from=builder /workspace/apps/web/.next/standalone ./

# Remove build-time-only dependencies that Next.js file tracing
# over-includes. These are never require()'d at runtime.
RUN find node_modules/.pnpm -maxdepth 1 -type d \
      \( \
        -name '@rspack*' \
        -o -name '@esbuild*' \
        -o -name 'webpack*' \
        -o -name 'terser*' \
        -o -name 'typescript*' \
        -o -name '@webassemblyjs*' \
        -o -name '@xtuc*' \
        -o -name '@module-federation*' \
        -o -name '@jridgewell*' \
        -o -name 'eslint*' \
        -o -name 'esrecurse*' \
        -o -name 'estraverse*' \
        -o -name 'enhanced-resolve*' \
        -o -name 'watchpack*' \
        -o -name 'loader-runner*' \
        -o -name 'schema-utils*' \
        -o -name 'tapable*' \
        -o -name 'jest-worker*' \
        -o -name 'merge-stream*' \
        -o -name 'glob-to-regexp*' \
        -o -name 'graceful-fs*' \
      \) -exec rm -rf {} + 2>/dev/null; \
    # Keep sharp (musl only — Alpine) for Next.js image optimization
    rm -rf node_modules/.pnpm/@img+sharp-libvips-linux-x64@* \
           node_modules/.pnpm/@img+sharp-linux-x64@* \
           2>/dev/null; \
    # Remove GNU libc native binaries (we're on Alpine/musl)
    find node_modules/.pnpm -maxdepth 1 -type d -name '*linux-x64-gnu*' -exec rm -rf {} + 2>/dev/null; \
    echo "Pruned standalone size:" && du -sh .

## ── Stage 4: runner ───────────────────────────────────────────
FROM node:22-alpine AS runner

WORKDIR /workspace

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# sharp musl binary is bundled in the pruned standalone; no system libvips needed

# Copy pruned standalone server + static assets
COPY --from=pruner /workspace ./
COPY --from=builder /workspace/apps/web/.next/static apps/web/.next/static

EXPOSE 3000

# Lightweight healthcheck — the standalone server responds on /
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/web/server.js"]
