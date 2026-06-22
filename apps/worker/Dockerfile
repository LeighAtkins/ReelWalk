FROM node:22-bookworm-slim

WORKDIR /workspace

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg python3 make g++ ca-certificates libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2 libatspi2.0-0 libxshmfence1 \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable

COPY package.json pnpm-workspace.yaml ./
COPY apps/worker/package.json apps/worker/package.json
COPY packages/render/package.json packages/render/package.json
RUN pnpm install --frozen-lockfile=false

COPY apps/worker apps/worker
COPY packages/render packages/render

CMD ["pnpm", "--filter", "@reelwalk/worker", "dev"]
