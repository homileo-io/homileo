---
name: dev
description: Homileo dev command reference. Use when starting the service locally, managing the Docker stack, running tests, building packages, running Prisma (generate, migrations), generating the tereo provisioning document, or running the format/lint/import-order checks before a PR.
---

# Homileo Dev Commands

There is no project CLI beyond `npm run cli -- <command>` for operators. Everything else is a root
npm script, an Nx target from a `packages/*/project.json`, Docker Compose, or Prisma run inside
`packages/homileo`. Commands below say which directory they run from.

## Quick Reference

| Task | Command | Run from |
|------|---------|----------|
| Install | `npm install` | root |
| Start Postgres + Redis only | `docker compose up -d postgres redis` | root |
| Start the whole stack (homileo, migrate, Postgres, Redis) | `docker compose up` | root |
| Run Homileo locally (watch) | `npm run dev` | `packages/homileo` |
| Run the unit tests (no database, Redis or server) | `npm run test:unit` | `packages/homileo` |
| Run the integration tests against local Postgres/Redis | `npm run test:int` | `packages/homileo` |
| Run one test file | `npx vitest run --project int src/tests/routes/v1/me/me.test.ts` | `packages/homileo` |
| Run tests by tag | `npm run test:local -- --tags-filter "auth && race"` (`npx vitest --list-tags`) | `packages/homileo` |
| Run the suite in an isolated Docker stack | `docker/test/run.sh` | root |
| Regenerate the Prisma client | `npx prisma generate` | `packages/homileo` |
| Create a migration (don't apply yet) | `npm run db:migrate -- --name <name>` | `packages/homileo` |
| Apply migrations | `npm run db:migrate:deploy` | `packages/homileo` |
| Browse the database | `npx prisma studio` | `packages/homileo` |
| Regenerate the tereo provisioning document | `npm run tereo:provisioning` | `packages/homileo` |
| Format (fix / check) | `npm run format` / `npm run format:check` | root |
| Import order (fix / check) | `npm run sort-imports` / `npm run sort-imports:check` | root |
| Lint | `npm run lint` | root |
| Lint / re-bundle the OpenAPI spec (from plan 2) | `npm run openapi:lint` / `npm run openapi:build` | `packages/homileo` |
| Type-check every package | `npm run check` | root |
| Create a version plan (`tereo-provisioning.json` embeds `homileo`'s version: regenerate it with `npm run tereo:provisioning` after every version bump) | `npm run version-plan` | root |

## Root npm scripts (`package.json`)

| Script | Runs |
|--------|------|
| `format` / `format:check` | Prettier over `packages/*/src/**/*.{ts,tsx,js,jsx,css}` and `scripts/` |
| `lint` | `eslint packages/ scripts/`, then each workspace's own `lint` script if it has one |
| `sort-imports` / `sort-imports:check` | `scripts/sort-imports.ts` — every package's `src/`. Sort specific paths with `npx tsx scripts/sort-imports.ts <file-or-dir>...` |
| `check` | `nx run-many -t check` (`tsc --noEmit` in every package) |
| `version-plan` | `nx release plan` — writes a file under `.nx/version-plans/` |

## Nx targets (`packages/*/project.json`)

Run with `npx nx run <project>:<target>`, or across projects with `npx nx run-many -t <target>`.

| Project | Targets |
|---------|---------|
| `homileo` | `generate` (prisma generate), `build` (tsc, after `^build` + `generate`), `check` (tsc --noEmit, after the same), `dev`, `test` (`vitest run`), `test:unit`, `test:docker` (`./docker/test/run.sh`), `docker` (`docker build -f docker/Dockerfile -t homileo .`, after `build`), `clean` |
| `@homileo-io/sdk` | `build`, `check` (both after `^build`), `test`, `clean` |

## `packages/homileo` npm scripts

| Script | Runs |
|--------|------|
| `dev` | `tsx watch src/index.ts` |
| `test` | `../../docker/test/run.sh` — the **Docker** suite, not local vitest |
| `test:unit` / `test:int` | `vitest run --project unit` / `--project int` |
| `test:local` | `vitest run` (both projects) |
| `test:watch` / `test:coverage` | `vitest` / `vitest run --coverage` |
| `db:generate`, `db:migrate:deploy`, `db:studio` | `prisma generate`, `prisma migrate deploy`, `prisma studio` |
| `db:migrate` | `prisma migrate dev --create-only` — creates a migration, doesn't apply it |
| `tereo:provisioning` | `tsx scripts/tereo-provisioning.ts` — rewrites `tereo-provisioning.json` |

## When to Use What

### Starting development

```sh
npm install
docker compose up -d postgres redis                      # host ports 5452 / 6399
cp packages/homileo/.env.example packages/homileo/.env   # TEREO_TEST_MODE=true, no tereo needed
cd packages/homileo
npx prisma generate && npx prisma migrate deploy
npm run dev                                              # http://localhost:4101
```

- **Just want it running**: `docker compose up` from the root. It builds the image from source,
  runs the `migrate` service (`docker/migrate.sh`: `prisma migrate deploy`), then starts `homileo`
  on 4101 with `TEREO_TEST_MODE=true`. The image is only built when missing — use
  `docker compose up --build` after code changes.
- Host ports are overridable: `HOMILEO_POSTGRES_PORT` (5452), `HOMILEO_REDIS_PORT` (6399),
  `HOMILEO_PORT` (4101).
- In test mode Homileo accepts `@tereo-io/sdk` test tokens
  (`test-token-<uuid>|org=<uuid>|perms=a,b`; a service account is `test-token-<uuid>|client=<uuid>`
  with the same UUID twice). Against a real tereo, set `TEREO_URL`, `TEREO_CLIENT_ID`,
  `TEREO_CLIENT_SECRET` and `REQUEST_HANDLER_KEY`, and give tereo the generated
  `packages/homileo/tereo-provisioning.json`.

### Running tests

- `npm run test:int` (in `packages/homileo`) reads `.env` and points it at a separate database and
  Redis db: `DATABASE_URL` with `_test` appended to the database name, and Redis db `1`.
  `TEST_DATABASE_URL` / `TEST_REDIS_URL` (shell or `.env`) override them, and `TEST_PORT` moves the
  server. `globalSetup` migrates that database itself. `npm run test:unit` needs no `.env`,
  database or Redis.
- The `int` project starts its **own server on port 4101** — stop `npm run dev` or the compose
  `homileo` container first.
- `int` files run serially (shared server and database); expect a few minutes. Where a test goes and
  how it is tagged: `packages/homileo/src/tests/README.md`.
- `docker/test/run.sh` needs only Docker: it builds a runner, splits the suite into `TEST_SHARDS`
  shards (default 4) run at once, each in its own throwaway stack (`TEST_STACK_PREFIX` names them),
  and tears them down.
- SDK tests: `npx nx run @homileo-io/sdk:test`.

### After Prisma schema changes

1. Edit `packages/homileo/prisma/schema.prisma`.
2. `npm run db:migrate -- --name <what_changed>` — generates the migration under
   `prisma/migrations/` without applying it.
3. Edit the generated SQL only where Prisma can't express something: append raw SQL for range
   partitioning (`chat.events`), partial/opclass indexes and CHECK constraints. On the partitioned
   table Prisma emits a PK-reset statement Postgres rejects — delete only that statement.
4. `npm run db:migrate:deploy`, then `npx prisma generate` if the client didn't regenerate.
   The test database is migrated by `globalSetup` on the next `npm run test:int`.

### After changing permissions or event types

Edit `packages/homileo-sdk/src/events/registry.ts` (event types) or
`src/definitions/tereoDeclaration.ts` (permissions), then `npm run tereo:provisioning` in
`packages/homileo` and commit `tereo-provisioning.json`; a unit test fails when it is stale.

### Before creating a PR

The same checks CI runs:

1. `npm run format` (then `npm run format:check`)
2. `npm run sort-imports` (then `npm run sort-imports:check`)
3. `npm run lint`
4. `npm run check`
5. `npm run openapi:lint` in `packages/homileo` if a spec changed (`npm run openapi:build` to re-bundle)
6. `npm run test:unit` and the focused `int` tests in `packages/homileo` (or `docker/test/run.sh`),
   plus `npx nx run @homileo-io/sdk:test` if the SDK changed
7. `npm run version-plan` if `@homileo-io/sdk` or `homileo` changed — commit the file in
   `.nx/version-plans/`.

### Docker management

| Command | Purpose |
|---------|---------|
| `docker compose up -d postgres redis` | Backing services for `npm run dev` |
| `docker compose up` / `docker compose up --build` | Whole stack / rebuild the image first |
| `docker compose logs -f homileo` | Tail the service |
| `docker compose down` | Stop, keep data |
| `docker compose down -v` | Stop **and delete** the database — ask first |
| `npx nx run homileo:docker` | Build the image tagged `homileo` (compose uses its own `homileo:local`) |

### Troubleshooting

- `.env not found at …` from vitest → copy `.env.example` to `.env` in `packages/homileo`.
- `EADDRINUSE` on port 4101 in tests → a dev server or the compose `homileo` container is still running.
- Prisma client out of date (missing model/field types) → `npx prisma generate`.
- Startup fails with `provisioning_invalid` → a provisioning document under `PROVISIONING_PATH` is
  wrong; the message names the document and key.

## Prisma and destructive database commands

Prisma detects when an AI agent runs it and refuses destructive commands — `prisma migrate reset`,
`prisma db push --force-reset`, `prisma db push --accept-data-loss` — with a message telling the
agent to stop and ask. The override is the `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION` env var.

**Never set that variable on your own judgment, and never work around the guard** — no
`DROP SCHEMA` through `psql`, no `docker compose down -v` to get the same effect. Stop and tell the
user the exact command, why you want it, that it irreversibly destroys the data, and which database
it would hit (`homileo` dev data or `homileo_test`). Only if the user then explicitly consents in
their own reply may the command be rerun with the variable set, as Prisma's message describes. The
test database rarely needs resetting — `docker/test/run.sh` gives a throwaway one.

## DO

- Run Prisma and vitest from `packages/homileo` (Prisma reads `DATABASE_URL` from `.env` there via
  `prisma.config.ts`).
- Generate migrations with `npm run db:migrate` (`--create-only`) and review the SQL before applying.
- Run the CI checks before pushing.

## DON'T

- Don't run `npm test` in `packages/homileo` expecting local vitest — it's the Docker suite; use
  `npm run test:unit` / `test:int`.
- Don't point tests at the dev database; `TEST_DATABASE_URL` exists to move the test database, not
  to share one.
- Don't run `prisma migrate reset`, `db push --force-reset` or `docker compose down -v` without the
  user's say-so.
