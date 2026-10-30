---
name: backend
description: Backend patterns for Homileo — the one Express/Prisma service (spaces, sessions, messages, events, provisioning). Use when creating or changing routes, controllers, Zod validation, error handling, db functions, Prisma models or migrations, permissions or event types, the access policy, or recordChange.
paths:
  - packages/homileo/src/**
  - packages/homileo/prisma/**
  - packages/homileo/openapi/**
---

# Backend Patterns

Homileo is **one service** (`packages/homileo`, port 4101) with **one database** — Postgres schemas
`chat` (Homileo's tables) and `core` (the tereo outbox). Areas (`spaces`, `sessions`, `messages`,
`events`, `provisioning`, `platform`) share one Express app, one `db` object and one env schema;
nothing calls another area over HTTP. Authentication, files, webhooks, notifications and audit are
**tereo's**, reached only through `@tereo-io/sdk`.

## Package Layout

```
packages/homileo/
├── prisma/schema.prisma          # The one schema; client generated to prisma/generated/client
├── openapi/                      # Plan 2 onward (see the `openapi` skill)
├── tereo-provisioning.json       # Generated from src/definitions/tereoDeclaration.ts
└── src/
    ├── index.ts / app.ts / worker.ts   # Entry, Express app, background work (ROLE=all|api|worker)
    ├── preload.ts                       # First import of every entry point (loads .env)
    ├── env.ts                           # The one Zod env schema — `import env from "./env.js"`
    ├── definitions/                     # tereoDeclaration.ts (what tereo is told), builtins.ts (the `default` kind)
    ├── middleware/auth.ts               # authenticate, requireOrganization, callerOf
    ├── policy/                          # The only place access is decided: spaces, sessions, messages
    ├── routes/                          # Mirrors the URL (see below)
    │   └── v1/{area}/…/{resource}/
    │       ├── index.ts                 # The one router: imports and route wiring only
    │       ├── controllers.ts           # Handlers
    │       ├── schemas.ts               # Zod schemas
    │       ├── middleware.ts            # Route-local middleware (guards), if any
    │       └── {item}/                  # The `/:id` sub-router
    ├── utils/
    │   ├── db/{table}.ts                # Prisma calls, one file per table group; db/index.ts = `db`
    │   ├── changes.ts                   # recordChange — event + tereo outbox rows in the caller's transaction
    │   ├── provisioning/                # load, validate, apply the provisioning documents
    │   └── tereo.ts                     # The one `getTereo()` (@tereo-io/sdk core client)
    ├── jobs/                            # eventPartitions and other background work, started from worker.ts
    └── tests/                           # Mirrors src/ (see the `test` skill and tests/README.md)
```

URL → folder: `routes/index.ts` is the root of the tree. It mounts `/health` (`routes/health/`) and
Homileo's API under `/v1` (`routes/v1/`, composed in `routes/v1/index.ts` with each area's
body-size limit). A new API route goes under `routes/v1/`.

## Route Layout and Registration Order

Where a route's files go, what each file holds, `:param` folders and the order routes register in
are in the `routes` skill (enforced by `tests/conventions/routeLayout.unit.test.ts`). **REQUIRED:** load it before
adding or moving a route.

## Validation

- Always Zod. `validateBody(schema, req)`, `validateParams(schema, req)`, `validateQuery(schema, req)`
  from `utils/validateReq.ts` — they throw `ValidationError` (400 `invalid_request`).
- Ids are UUIDv7 (`uuid` package `v7()`): param schemas use `z.guid()` — any 8-4-4-4-12 hex id, as
  Postgres takes it (`z.uuid()` refuses ids outside RFC 9562's variants).
- Extra query flags (e.g. `includeArchived`) parse booleans with
  `z.enum(["true","false"]).transform(v => v === "true")`, never `z.coerce.boolean()`.
- Message payloads of provisioned types are validated against their JSON Schema with Ajv (2020-12);
  event payloads against the Zod schema in `@homileo-io/sdk`'s registry.

## Error Handling

- Throw the classes from `utils/errors.ts` — never `res.status().json()` for errors. All extend
  `AppError`; the body is `{ error: <code>, error_description, ...details }`.
- `ValidationError` 400 · `BadRequestError(code, message)` 400 · `UnauthorizedError` 401 ·
  `ForbiddenError` 403 · `NotFoundError` 404 · `ConflictError(message, code?)` 409 ·
  `ManagedByProvisioningError` 409 `managed_by_provisioning` · `TooManyRequestsError` 429 ·
  `ServiceUnavailableError` 503. `organization_required` (400) comes from `requireOrganization`;
  `provisioning_invalid` is startup/CLI only.
- A 404 means the row is not there **or the caller may not see it** — never reveal that a session
  the caller cannot read exists.
- Prisma constraint errors: `mapUniqueViolation(fn, msg, code)` and
  `rethrowRestrictedAsConflict(err, msg)` (`utils/prismaErrors.ts`) turn them into 409s.
- `errorHandler` (last in `app.ts`, after a catch-all `NotFoundError`) writes the body.

## Authentication, Organizations and Access

- `authenticate` (`middleware/auth.ts`) wraps tereo's `requireAuth` (introspection, cached, or test
  tokens in test mode), upserts the caller's principal, and sets `req.caller`. The organization is only the
  token's `org_id`; no header names one.
- `authenticate` then `requireOrganization` go once on the `/v1` router, so every `/v1` request has
  an organization (a token without one gets 400 `organization_required`). Controllers read the
  caller with `callerOf(req)`; `organizationId` is always a string.
- **Every space and session belongs to one tereo organization**; every read, write, event and
  search is limited to the caller's current organization. Lists put `organizationId` in the base
  `where`. Principals themselves are not organization-scoped.
- **Access is decided only in `src/policy/`** (`canReadSpace`, `canPostInSession`, the "readable
  sessions" SQL condition, …). Routes, controllers, the socket layer and search call the policy;
  they never inline a visibility, role or grant check. `homileo.chat.admin` does not read DMs or
  space-less sessions.
- Permissions are tereo's dotted, hierarchical form (`utils/permissions.ts`, `hasPermission`):
  `x.admin` includes `x.write` includes `x.read`; the bare `admin` covers everything.

## Database Layer

- Prisma calls live in `utils/db/{table}.ts`, aggregated by `utils/db/index.ts` into one default
  export: `import db from "../../utils/db/index.js"` → `db.principals.findOrCreateUser(…)`.
- Controllers call `db.*`, not `prisma`.
- Every write function takes an optional transaction: `(…, tx?: Prisma.TransactionClient)` with
  `const db = tx ?? prisma;`. Controllers open `db.$transaction(async (tx) => …)`.
- `get` throws `NotFoundError`; `findById` / `getBy…` return `null` for the caller to decide.
- **Raw SQL** names the schema on every table — `"chat"."events"`, `"core"."outbox"`. There is no
  `public` schema.

## Prisma Conventions

- One `prisma/schema.prisma`; every model and enum carries `@@schema("chat" | "core")`. Import the
  client and types from `prisma/generated/client/index.js`.
- `id String @id @default(uuid(7)) @db.Uuid` (`events` uses a `BigInt` identity so ordering is the
  log's order); foreign keys `@db.Uuid`; timestamps `@db.Timestamp(3)`, UTC.
- camelCase fields, `@map("snake_case")` columns, `@@map("table_name")` tables.
- `createdAt @default(now())`, `updatedAt @updatedAt`, both mapped.
- **Actors** are `principals` (`chat.principals`), not tereo users: there are no foreign keys into
  tereo's database. A tereo `service_account` user is a bot, always — `is_bot` is derived, never
  set by callers.
- **Archive, don't delete**: archivable rows have `archivedAt DateTime? @map("archived_at")`. A
  deleted message clears its body and keeps its revisions.
- Organization-owned rows carry `organizationId` (a tereo id, a plain `@db.Uuid`).

## Migrations

- `npx prisma migrate dev --create-only --name <name>`, review, then `npx prisma migrate deploy`.
- Append raw SQL only for what Prisma can't express: range partitioning (`chat.events`),
  partial/opclass/trigram/GIN indexes, CHECK constraints.
- On the partitioned `events` table Prisma emits a PK-reset statement Postgres rejects — delete
  only that statement.

## The Write Path: `recordChange`

Every mutation runs **in one transaction** that updates the rows, then calls `recordChange(tx, …)`
from `utils/changes.ts`, which validates the payload against the SDK's event schema, inserts into
`chat.events`, and — through `@tereo-io/sdk`'s outbox — writes the tereo webhook row
(`outbox.emit`) and, when `audit` is given, the audit row (`outbox.audit`):

```typescript
const session = await prisma.$transaction(async (tx) => {
  const created = await db.sessions.create(input, tx);
  await recordChange(tx, {
    type: "session.created",
    organizationId: caller.organizationId,
    spaceId: created.spaceId,
    sessionId: created.id,
    actorId: caller.principalId,
    entity: { type: "Session", id: created.id },
    payload: formatSession(created),
    audit: { action: "CREATE", userId: caller.tereoUserId },
  });
  return created;
});
```

After commit, the socket layer publishes the event; realtime, `GET /v1/sync` and webhooks therefore
carry the same events with the same ids. For the outbox mechanics, invoke the `outbox` skill.

- Event types are `<area>.<verb>` in Homileo and `homileo.<area>.<verb>` in tereo; they live in the
  SDK's `EVENT_TYPES` registry. `recordChange` throws on an unlisted type.
- Never write an event or outbox row outside the mutation's transaction, or fire-and-forget after commit.

## Provisioning

Apps declare space kinds and message types in provisioning documents (`PROVISIONING_PATH`), read
at every start, validated as a whole set and applied in one transaction (`utils/provisioning/`);
unknown keys are refused, removed items retire, and provisioned rows are read-only through the API
(`409 managed_by_provisioning`). Homileo's own tereo declaration (permissions, bucket, event types,
roles) is generated: `npm run tereo:provisioning` in `packages/homileo`.

## App Wiring

- `app.ts` order: `trust proxy` → `createRequestIdMiddleware()` → `helmet()` → CORS → `routes`
  (`routes/index.ts`) → catch-all `NotFoundError` → `errorHandler`.
- `routes/index.ts`: `/health` (DB + Redis probe, 503 `degraded` on failure), then `/v1`.
- `index.ts` start order: Redis → provisioning → `ensureEventPartitions()` → worker (if `ROLE` runs
  it) → listen. Shutdown drains and closes Postgres and Redis.
- Background work goes in `src/jobs/`, started from `worker.ts`.

## Environment Variables

- One schema: `src/env.ts` (`parseEnv`, default export `env`). Add the variable there with a Zod
  type and default; empty values count as unset.
- Never read `process.env` elsewhere. `src/preload.ts` must be the first import of every entry point.
- `TEREO_TEST_MODE` is refused when `NODE_ENV=production`.

## Adding a Resource

1. `src/routes/v1/{area}/…/{resource}/` with `index.ts`, `schemas.ts`, `controllers.ts`, plus
   `{item}/` for the `/:id` routes (see the `routes` skill)
2. Model in `prisma/schema.prisma` (`@@schema("chat")`), migration via `--create-only`
3. `src/utils/db/{table}.ts`, added to `utils/db/index.ts`
4. Access rules in `src/policy/`, with table-driven unit tests
5. Event types in the SDK registry; `recordChange` in every mutation; regenerate
   `tereo-provisioning.json` if a webhook event or permission was added
6. Mount the router in its parent `index.ts` (respect registration order)
7. OpenAPI paths and schemas; tests mirroring the route under `src/tests/routes/` (see the `test` skill)

## DO

- Validate every input with `validateBody/Params/Query`; throw error classes for every failure
- Keep Prisma in `utils/db/`; pass `tx` through for writes inside a transaction
- `recordChange` inside the mutation's transaction
- Decide access only through `src/policy/`; scope every query by the caller's organization
- `.js` on every relative import; imports sorted longest-first (`npm run sort-imports`)
- Log with Pino, object first: `logger.info({ sessionId }, "msg")`; errors under `err`

## DON'T

- Never `res.status(400).json(...)` — throw
- Never record changes outside the transaction, or fire-and-forget after commit
- Never inline an access check in a route, controller, socket handler or search query
- Never read `process.env` outside `env.ts`
- Never write raw SQL without the schema prefix
- Never use `any` — `unknown` and narrow
- Never add app-specific behaviour (a support queue, a bot's logic) — apps extend Homileo through
  its public API and provisioning documents
- Never add external API integrations (they belong in [dianemo-plugins](https://github.com/dianemo/dianemo-plugins))

## Additional Resources

- Related skills: `routes`, `outbox`, `openapi`, `test`
- Per-area notes: `packages/homileo/docs/{provisioning,events,access}.md`
- Conventions: `CLAUDE.md`, `docs/code-style.md`; the design: `docs/superpowers/specs/2026-10-30-homileo-design.md`
