FROM nginx:1.27-alpine

RUN apk add --no-cache apache2-utils

# Bake the proxy config into the image. This avoids the Docker-node bind-mount
# path translation that turns the file mount into a directory at runtime.
COPY default.conf /etc/nginx/conf.d/default.conf

# Default credentials — change password after first deploy
RUN htpasswd -bc /etc/nginx/.htpasswd leigh reelwalk2026
