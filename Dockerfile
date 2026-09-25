FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c AS build
WORKDIR /app
RUN npm i -g pnpm@10.34.5
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c
# The release this image was built from (set by the GitHub release build). "dev" for local builds: no update check.
ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}
ENV NODE_ENV=production REF_DIR=/app/ref SETTINGS_PATH=/data/settings.json
WORKDIR /app
# OKX CLI profiles (site = "eea", no keys; keys come from the environment per call) and its 7-day trade log live here.
RUN mkdir -p /home/node/.okx /data && chown -R node:node /home/node /data
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node scripts/okx-profiles.sh ./scripts/okx-profiles.sh
# The three original portraits: the default art, and the style reference for generated bees.
COPY --chown=node:node dashboard/public/bees ./ref
USER node
ENV HOME=/home/node
RUN sh ./scripts/okx-profiles.sh
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/index.js"]
