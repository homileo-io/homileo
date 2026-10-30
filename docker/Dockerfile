# syntax=docker/dockerfile:1
#
# Homileo. Builds from source; run from the repo root:
#
#   docker build -f docker/Dockerfile -t homileo .
#
# One image for every role: ROLE=all (default), api, or worker. The same image
# runs `./migrate.sh` as the migrate step (compose's `migrate` service, or a
# Kubernetes Job).

# ---------------------------------------------------------------------------
# Build: the SDK, then the service, compiled with dev dependencies. The
# service resolves @homileo-io/sdk from its dist, so the SDK builds first.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/homileo-sdk/package.json ./packages/homileo-sdk/
COPY packages/homileo/package.json ./packages/homileo/
COPY packages/homileo/prisma.config.ts ./packages/homileo/
COPY packages/homileo/prisma ./packages/homileo/prisma/

RUN --mount=type=cache,target=/root/.npm,sharing=shared \
    npm ci --workspace=homileo-sdk --workspace=homileo

RUN cd packages/homileo && npx prisma generate

COPY packages/homileo-sdk/tsconfig.json ./packages/homileo-sdk/
COPY packages/homileo-sdk/src ./packages/homileo-sdk/src
RUN npx tsc -p packages/homileo-sdk

COPY packages/homileo/tsconfig.json ./packages/homileo/
COPY packages/homileo/src ./packages/homileo/src

RUN npx tsc -p packages/homileo

# ---------------------------------------------------------------------------
# Runtime: production dependencies and compiled output only.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime

WORKDIR /app

# dumb-init for signal handling, wget for the health check.
RUN apk add --no-cache dumb-init wget

COPY package.json package-lock.json ./
COPY packages/homileo-sdk/package.json ./packages/homileo-sdk/
COPY packages/homileo/package.json ./packages/homileo/
COPY packages/homileo/prisma.config.ts ./packages/homileo/
COPY packages/homileo/prisma ./packages/homileo/prisma/

RUN --mount=type=cache,target=/root/.npm,sharing=shared \
    npm ci --workspace=homileo-sdk --workspace=homileo --omit=dev

RUN cd packages/homileo && npx prisma generate

COPY --from=build /app/packages/homileo-sdk/dist ./packages/homileo-sdk/dist
COPY --from=build /app/packages/homileo/dist ./packages/homileo/dist

COPY docker/migrate.sh ./packages/homileo/

RUN chmod +x packages/homileo/migrate.sh && \
    addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    chown -R nodejs:nodejs /app/packages/homileo

USER nodejs

WORKDIR /app/packages/homileo

# Production unless overridden: JSON logs, and the PUBLIC_URL / TRUST_PROXY
# checks. docker-compose.yml sets development for its localhost stack.
ENV NODE_ENV=production

# A worker has no HTTP port, so only the other roles are probed.
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD [ "$ROLE" = "worker" ] || wget --quiet --tries=1 --spider "http://localhost:${PORT:-4101}/health" || exit 1

EXPOSE 4101

ENTRYPOINT ["dumb-init", "--"]

CMD ["node", "dist/index.js"]
