## ── Stage 1: deps ─────────────────────────────────────────────
FROM node:22-alpine AS deps

WORKDIR /workspace
RUN corepack enable

# Only manifests first, so the install layer is reused until a dependency changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/db/package.json packages/db/package.json
RUN pnpm install --frozen-lockfile --filter @reelwalk/web...

## ── Stage 2: builder ──────────────────────────────────────────
FROM deps AS builder

ENV NEXT_TELEMETRY_DISABLED=1

COPY apps/web apps/web
COPY packages/core packages/core
COPY packages/db packages/db

RUN pnpm --filter @reelwalk/db db:generate \
  && pnpm --filter @reelwalk/web build

## ── Stage 3: runner ───────────────────────────────────────────
FROM node:22-alpine AS runner

WORKDIR /workspace

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Nothing installs packages at runtime, so the package managers (and their
# own vulnerable dependencies) are removed.
RUN apk upgrade --no-cache \
  && rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn-*

# The standalone output contains the server and only the node_modules it traces.
COPY --from=builder /workspace/apps/web/.next/standalone ./
COPY --from=builder /workspace/apps/web/.next/static apps/web/.next/static

USER node
EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/web/server.js"]
