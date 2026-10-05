## ── Stage 1: runtime base ─────────────────────────────────────
FROM node:22-bookworm-slim AS runtime

# Security updates, then ffmpeg plus the shared libraries Chrome Headless Shell needs.
RUN apt-get update \
  && apt-get upgrade -y \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2 libatspi2.0-0 libxshmfence1 \
  && rm -rf /var/lib/apt/lists/*

## ── Stage 2: build ────────────────────────────────────────────
FROM runtime AS build

WORKDIR /workspace
RUN corepack enable

# Only manifests first, so the install layer is reused until a dependency changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/worker/package.json apps/worker/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/render/package.json packages/render/package.json
# --prod: test and type tooling (and the old esbuild builds they pull in) stay out of the image.
RUN pnpm install --frozen-lockfile --prod --filter @reelwalk/worker...

COPY apps/worker apps/worker
COPY packages/core packages/core
COPY packages/db packages/db
COPY packages/render packages/render

RUN pnpm --filter @reelwalk/db db:generate

WORKDIR /workspace/apps/worker

# Download Chrome Headless Shell at build time. Otherwise every new pod would
# fetch ~90 MB before its first render.
RUN node_modules/.bin/tsx src/ensure-browser.ts

## ── Stage 3: runner ───────────────────────────────────────────
FROM runtime AS runner

# Nothing installs packages at runtime, so the package managers (and their
# own vulnerable dependencies) are removed. The pnpm store stays in the build stage.
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn-*

COPY --from=build /workspace /workspace
WORKDIR /workspace/apps/worker

USER node
EXPOSE 8081

# Run tsx directly: with a package manager in between, SIGTERM would not
# reach the worker and graceful shutdown would never run.
CMD ["node_modules/.bin/tsx", "src/index.ts"]
