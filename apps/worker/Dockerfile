## ── Stage 1: runtime base ─────────────────────────────────────
FROM node:23-bookworm-slim AS runtime

# Security updates, then ffmpeg plus the shared libraries Chrome Headless Shell needs,
# and pg_dump 17 (from the PostgreSQL project's repository, matching Supabase's
# server) for the nightly backup task.
# The upgrade layer is rebuilt whenever this ARG changes: bump the date when Debian ships
# fixes that CI's cached layer lacks (2026-10-21: libssh 0.10.6-0+deb12u3;
# 2026-10-23: libexpat1 2.5.0-1+deb12u5 for CVE-2025-59375 / CVE-2026-77214).
ARG BASE_REFRESH=2026-10-23
RUN apt-get update \
  && apt-get upgrade -y \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && install -d /usr/share/postgresql-common/pgdg \
  && curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
  && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends postgresql-client-17 \
  && apt-get purge -y curl && apt-get autoremove -y \
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
# Durable AI steps (ADR 0049) run the web app's own step module. Only lib/ is
# needed; its imports resolve through the worker's dependencies.
COPY apps/web/lib apps/web/lib
RUN ln -s ../worker/node_modules apps/web/node_modules

RUN pnpm --filter @reelwalk/db db:generate

WORKDIR /workspace/apps/worker

# Download Chrome Headless Shell at build time. Otherwise every new pod would
# fetch ~90 MB before its first render.
RUN node_modules/.bin/tsx src/ensure-browser.ts

# The speech-recognition model (about 240 MB) for word-timed transcripts
# (src/transcribe.ts), cached here so a render task never downloads it.
RUN node_modules/.bin/tsx scripts/fetch-whisper.ts /workspace/models

## ── Stage 3: runner ───────────────────────────────────────────
FROM runtime AS runner

# Nothing installs packages at runtime, so the package managers (and their
# own vulnerable dependencies) are removed. The pnpm store stays in the build stage.
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn-*

COPY --from=build /workspace /workspace
WORKDIR /workspace/apps/worker

ENV TRANSCRIBE_MODEL_DIR=/workspace/models

USER node
EXPOSE 8081

# Run tsx directly: with a package manager in between, SIGTERM would not
# reach the worker and graceful shutdown would never run.
CMD ["node_modules/.bin/tsx", "src/index.ts"]
