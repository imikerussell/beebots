# beebots web: the React dashboard built into a Caddy image (automatic HTTPS, reverse proxy to the engine).
# Build context is the repo root; deploy/web.Dockerfile.dockerignore limits it to the dashboard + Caddyfile.
FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c AS build
WORKDIR /app
RUN npm i -g pnpm@10.34.5
COPY dashboard/package.json dashboard/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY dashboard/ ./
RUN pnpm build

FROM caddy:2-alpine@sha256:6aeddd44c3078b0f9a35206472a11420648a79c184603ef95957d0a20044cb2b
# The image ships caddy with a file capability (cap_net_bind_service=ep). Under cap_drop ALL the kernel refuses to exec
# such a binary (EPERM), so strip it: compose runs Caddy as uid 1000 with a namespaced unprivileged-port sysctl instead.
# Named volumes copy the ownership of their mount point, so /data and /config must belong to uid 1000 in the image.
RUN apk add --no-cache libcap && setcap -r /usr/bin/caddy && apk del libcap \
 && mkdir -p /data /config && chown -R 1000:1000 /data /config
COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/dist /srv/dashboard
