FROM node:22-bookworm-slim

WORKDIR /workspace

# ffmpeg plus the shared libraries Chrome Headless Shell needs.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2 libatspi2.0-0 libxshmfence1 \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable

# Only manifests first, so the install layer is reused until a dependency changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/worker/package.json apps/worker/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/render/package.json packages/render/package.json
RUN pnpm install --frozen-lockfile --filter @reelwalk/worker...

COPY apps/worker apps/worker
COPY packages/core packages/core
COPY packages/db packages/db
COPY packages/render packages/render

RUN pnpm --filter @reelwalk/db db:generate

WORKDIR /workspace/apps/worker

# Download Chrome Headless Shell at build time. Otherwise every new pod would
# fetch ~90 MB before its first render.
RUN node_modules/.bin/tsx src/ensure-browser.ts

USER node
EXPOSE 8081

# Run tsx directly: with pnpm in between, SIGTERM would not reach the worker
# and graceful shutdown would never run.
CMD ["node_modules/.bin/tsx", "src/index.ts"]
