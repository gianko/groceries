# syntax=docker/dockerfile:1
#
# Built for the household Pi (arm64) via multi-arch buildx, e.g.:
#   docker buildx build --platform linux/arm64 -t pantry-bot .
# No secrets or IDs are ever ARG/ENV'd here — they arrive at `docker run`/
# compose time via env (see docker-compose.yml).

FROM node:22-slim AS base
RUN corepack enable
WORKDIR /app

# better-sqlite3 needs a native build step (node-gyp -> python3/make/g++).
FROM base AS deps
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml ./
# --ignore-scripts skips this project's own "postinstall" (lefthook install,
# which needs a .git dir we deliberately don't COPY into the image); rebuild
# then reruns just the allow-listed dependency scripts (better-sqlite3's
# native build step, esbuild's) via pnpm.onlyBuiltDependencies.
RUN pnpm install --frozen-lockfile --ignore-scripts && pnpm rebuild better-sqlite3

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

FROM deps AS prod-deps
RUN pnpm install --frozen-lockfile --prod --ignore-scripts && pnpm rebuild better-sqlite3

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY drizzle ./drizzle
COPY package.json ./

RUN useradd --system --uid 1001 --create-home pantry \
  && mkdir -p /data \
  && chown -R pantry:pantry /data
USER pantry

VOLUME ["/data"]

# No inbound ports anywhere in this image — the bot only makes outbound
# calls (Telegram, Gemini). Liveness comes from the heartbeat file instead.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "dist/healthcheck.js"]

CMD ["node", "--enable-source-maps", "dist/index.js"]
