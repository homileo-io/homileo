# syntax=docker/dockerfile:1
# Integration-test runner for Homileo: dev dependencies installed, the sources
# copied, the SDK built, and the test suite as the command. Driven by
# docker/test/run.sh.
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/homileo-sdk/package.json ./packages/homileo-sdk/
COPY packages/homileo/package.json ./packages/homileo/
COPY packages/homileo/prisma.config.ts ./packages/homileo/
COPY packages/homileo/prisma ./packages/homileo/prisma/

RUN --mount=type=cache,target=/root/.npm,sharing=shared \
    npm ci --workspace=homileo-sdk --workspace=homileo

RUN cd packages/homileo && npx prisma generate

# The service resolves @homileo-io/sdk from its dist.
COPY packages/homileo-sdk ./packages/homileo-sdk
RUN npx tsc -p packages/homileo-sdk

COPY packages/homileo ./packages/homileo

WORKDIR /app/packages/homileo

# globalSetup migrates the database itself.
CMD ["sh", "-c", "exec npx vitest run --project int ${TEST_SHARD:+--shard=$TEST_SHARD}"]
