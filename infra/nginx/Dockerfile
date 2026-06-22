FROM nginx:1.27-alpine

# Bake the proxy config into the image. This avoids the Docker-node bind-mount
# path translation that turns the file mount into a directory at runtime.
COPY default.conf /etc/nginx/conf.d/default.conf
