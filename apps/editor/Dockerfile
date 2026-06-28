# Build stage
FROM node:24-alpine AS build
WORKDIR /workspace

# Enable pnpm via corepack
RUN corepack enable

# Copy workspace root for pnpm workspace resolution
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/editor/package.json apps/editor/

# Install editor deps
RUN pnpm install --filter @reelwalk/editor

# Copy editor source
COPY apps/editor/ apps/editor/

# Build
RUN cd apps/editor && pnpm build

# Serve stage — lightweight nginx for static SPA
FROM nginx:1.27-alpine

# SPA fallback: serve index.html for all routes
RUN echo 'server { \
  listen 80; \
  root /usr/share/nginx/html; \
  index index.html; \
  location /editor/ { \
    alias /usr/share/nginx/html/; \
    try_files $uri $uri/ /editor/index.html; \
  } \
  location = / { \
    return 302 /editor/; \
  } \
}' > /etc/nginx/conf.d/default.conf

COPY --from=build /workspace/apps/editor/dist /usr/share/nginx/html
EXPOSE 80
