# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project Overview

**Homileo** (`homileo`; Greek *homileō*, "to converse") is a generic chat service for apps built on
[tereo](https://github.com/tereo-io/tereo). It owns the hard parts of chat — spaces, sessions,
messages, threads, reactions, mentions, read state, attachments, presence, search, realtime
delivery and catch-up — so an app extends it with its own data instead of rebuilding them. It stays
generic: app-specific features are the test of its public API, never special cases inside it.

Homileo is a **tereo app service**, deployed once per app, beside that app's tereo, with its own
Postgres and Redis. tereo supplies authentication (`requireAuth`), organizations, file storage,
webhooks, notifications and audit; Homileo reaches all of it only through `@tereo-io/sdk`.

It is **one service** — `packages/homileo`, port 4101 — with one Postgres database (schemas `chat`
and `core`). The other packages are `@homileo-io/sdk` (`packages/homileo-sdk`: the contract — Zod
event registry and provisioning document types now, the typed client later), and, in later plans,
`@homileo-io/react` and the standalone `homileo-ui`.

Read [README.md](README.md) first (its *Current state* section lists the plans), then the design:
[docs/superpowers/specs/2026-10-30-homileo-design.md](docs/superpowers/specs/2026-10-30-homileo-design.md).
The plans are beside it in `docs/superpowers/plans/`.

## How it fits together

- **Principals, not users.** Every actor is a `principal` (`chat.principals`). A signed-in tereo user
  becomes a `user` principal on first request; any tereo `service_account` is a bot, always
  (`is_bot` is derived, never set by callers). There are no foreign keys into tereo's database.
- **Organizations.** Every space and session belongs to one tereo organization, and every read,
  write, event and search is limited to the caller's current organization. Principals are not
  organization-scoped.
- **Spaces and sessions.** A space is a collection of sessions; a session is a 1-on-1 or group chat
  and may have no space (DMs, ad-hoc groups). Session access can only narrow the space's, never
  widen it. `homileo.chat.admin` cannot read DMs or space-less sessions.
- **Every mutation goes through `recordChange`** (`utils/changes.ts`): in the mutation's
  transaction it inserts into `chat.events` and writes tereo's outbox rows (webhook and, when asked,
  audit). Realtime, `GET /v1/sync` and webhooks carry the same events with the same ids.
- **Access checks only through `src/policy/`.** Routes, controllers, sockets and search call the
  policy; none of them inlines a visibility, role or grant check.
- **Contract types live in `@homileo-io/sdk`**: the event registry (`EVENT_TYPES`, one Zod schema
  per event) and the provisioning document schema. The service imports them; it does not define
  its own copies.
- **Apps extend Homileo through provisioning documents**, not HTTP registration: a folder of JSON
  (`PROVISIONING_PATH`) declaring space kinds and message types, read at every start, validated as
  a whole set and applied in one transaction. Provisioned rows are read-only through the API
  (`409 managed_by_provisioning`); removed ones retire.
- **Homileo's own tereo declaration** (permissions `homileo.chat.admin`, `homileo.spaces.read`,
  `homileo.spaces.write`; bucket `homileo-attachments`; the webhook event types) is generated from
  `src/definitions/tereoDeclaration.ts` into `packages/homileo/tereo-provisioning.json`.

## Layout of `packages/homileo`

One ordinary package, shared by every area:

| Path | Holds |
|------|-------|
| `src/index.ts` / `app.ts` / `worker.ts` | Entry point, Express app, background work. `ROLE` = `all` / `api` / `worker` |
| `src/env.ts` | The one env schema. `src/preload.ts` must be the first import of every entry point |
| `src/definitions/` | `tereoDeclaration.ts` (what tereo is told), `builtins.ts` (the built-in `default` space kind) |
| `src/middleware/auth.ts` | `authenticate`, `callerOf` |
| `src/policy/` | The access policy: `spaces.ts`, `sessions.ts`, `messages.ts`, and the "readable sessions" SQL condition |
| `src/routes/` | Mirrors the URL. `index.ts` is the root: `health/` at the root, the API under `v1/` (`me/`, then `spaces/`, `sessions/`, `messages/`, `events/`) |
| `src/utils/`, `src/utils/db/`, `src/jobs/` | Shared. `db` is one object across all tables; `changes.ts` is `recordChange`; `provisioning/` loads and applies documents; `tereo.ts` is the one SDK client |
| `src/cli/` | Operator commands, `npm run cli -- <command>` |
| `src/tests/` | Mirrors `src/`: `<base>[.<aspect>][.unit].test.ts`, `flows/`, `conventions/`; `setup/`, `support/`, `fixtures/` are not tests. Two projects, `unit` (no server) and `int` (one real server). Rules: [src/tests/README.md](packages/homileo/src/tests/README.md) |
| `prisma/` | The one schema and migrations |
| `docs/` | Per-area reference notes (`provisioning`, `events`, `access`) |

## Key conventions

- **Style is enforced by CI** ([docs/code-style.md](docs/code-style.md)): Prettier, import order
  (single-line imports longest first, then multi-line — `npm run sort-imports`), ESLint, `tsc`. Run
  `npm run format && npm run sort-imports && npm run lint` before committing. A change to
  `@homileo-io/sdk` or `homileo` (release groups `sdk` and `core`; `core`'s version tags the image)
  needs a version plan (`npm run version-plan`).
- **ESM only.** Every package is `"type": "module"` with `.js` extensions on all relative imports,
  including directory imports (`./v1/index.js`, not `./v1`).
- **Route layout** (`routes` skill; `tests/conventions/routeLayout.unit.test.ts`): folders mirror the URL; each
  `index.ts` is one router and only wires routes; handlers in `controllers.ts`, Zod in `schemas.ts`,
  route-local middleware in `middleware.ts`; every `:param` is mounted from its own singular folder
  (`/sessions/:sessionId` → `sessions/session/`); register static paths, then `:param` mounts, then `/`.
- **Validation**: always Zod — `validateBody/Params/Query` from `utils/validateReq.ts`, Zod schemas
  for env vars; JSON Schema (Ajv 2020-12) only for provisioned message-type payloads.
- **Errors**: `AppError` subclasses from `utils/errors.ts` — never `res.status(400).json(...)`
  directly. The body is `{ error: <code>, error_description, ...details }`. A resource the caller
  may not see is a 404.
- **Auth**: `authenticate` (tereo's `requireAuth`, then the principal) refuses a token without `org_id`, and sits once on the `/v1`
  router: the organization is the token's `org_id` only, and a token without one (person or service
  account) gets 400 `organization_required`. Permissions are
  tereo's dotted, hierarchical form (`utils/permissions.ts`): `write` includes `read`, `admin`
  includes all. There is no test-mode shortcut in the service: tests use `@tereo-io/sdk` test
  tokens (`test-token-<uuid>|org=<uuid>|perms=a,b`; a service account is
  `test-token-<uuid>|client=<uuid>`, the same UUID twice).
- **Identifiers and time**: IDs are UUIDv7 (`uuid` package `v7()`); timestamps are `timestamp(3)` UTC.
  `chat.events` uses a `bigint` identity so its order is the log's order.
- **Events**: named `<area>.<verb>` in Homileo and `homileo.<area>.<verb>` in tereo; they must be
  in the SDK's `EVENT_TYPES` (and, for webhooks, in the tereo declaration).
- **Migrations**: generated by Prisma (`migrate dev --create-only`), with raw SQL appended only for
  what Prisma cannot express — range partitioning (`chat.events`), partial, opclass and trigram
  indexes, CHECK constraints. On the partitioned table Prisma emits a PK-reset statement Postgres
  rejects; delete only that statement.
- **Raw SQL** names tables with their schema (`"chat"."events"`) — there is no `public` schema.
- **Logging**: JSON via Pino, object first (`logger.info({ meta }, "msg")`), with `request_id`
  added during a request. Errors go under `err` (`logger.error({ err }, "msg")`).
- **Repo is private**: `"license": "UNLICENSED"` in every `package.json`; no LICENSE or NOTICE files.

## Local development

```sh
npm install
docker compose up -d postgres redis                      # host ports 5452 / 6399
cp packages/homileo/.env.example packages/homileo/.env   # TEREO_TEST_MODE=true; no tereo needed
cd packages/homileo
npx prisma generate && npx prisma migrate deploy
npm run dev                                              # http://localhost:4101
npm run test:unit                                        # no database or Redis needed
npm run test:int                                         # uses <db>_test and Redis db 1 (TEST_DATABASE_URL overrides)
npm run test:local -- --tags-filter "auth && race"       # a tag expression; npx vitest --list-tags
```

`docker compose up` builds the image from source, runs `migrate`, then Homileo on
http://localhost:4101 with `TEREO_TEST_MODE=true`. `docker/test/run.sh` runs the suite in isolated
stacks, one per shard (`TEST_SHARDS`, default 4). Neither needs a `.env`. The packages and the
Docker, test and CI pieces arrive over plan 1 (see README); commands above work once they exist.

Against a real tereo, set `TEREO_URL`, `TEREO_CLIENT_ID`, `TEREO_CLIENT_SECRET` and
`REQUEST_HANDLER_KEY`, and give tereo the generated `packages/homileo/tereo-provisioning.json`.

## Skills

`.claude/skills/` holds task guides, adapted from tereo's: `routes`, `backend`, `outbox`, `test`,
`openapi`, `docs`, `dev`, `new-feature`, `comments`, `pr-description`. Load `routes` before adding a
route and `backend` before changing a mutation.

## What not to do

- Do not put app-specific behaviour in Homileo (a support queue, a bot's logic). Build it in the
  app on Homileo's public API; if that is impossible, the API is what needs to change.
- Do not check access anywhere but `src/policy/`.
- Do not write an event or outbox row outside the mutation's transaction, or after commit.
- Do not reach tereo except through `@tereo-io/sdk`, and do not add foreign keys into its tables.
- Do not add external API integrations here. They belong in
  [dianemo-plugins](https://github.com/dianemo/dianemo-plugins).
- Do not use `git stash` (shared refs across worktrees have swapped work before).
