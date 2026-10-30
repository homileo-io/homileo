---
name: new-feature
description: End-to-end checklist for adding a feature to Homileo — event types, schema, policy, routes, recordChange, OpenAPI, tests, docs and SDK
disable-model-invocation: true
argument-hint: "<feature-name> [area: spaces|sessions|messages|events|provisioning|platform]"
---

# New Feature Checklist

End-to-end guide for adding **$ARGUMENTS** to Homileo.

Homileo is one service, `packages/homileo` (port 4101), with one Postgres database and the schemas
`chat` and `core`. All paths below are relative to `packages/homileo` unless they start with
`packages/`. Commands are in the `dev` skill. Check the design spec
(`docs/superpowers/specs/2026-10-30-homileo-design.md`) first: it records the decision this feature
implements, and Homileo stays generic — an app-specific need belongs in the app, through the
public API and provisioning documents.

## Step 1: Contract (`packages/homileo-sdk`)

- [ ] Event types → `packages/homileo-sdk/src/events/registry.ts` (`EVENT_TYPES`), format
      `<area>.<verb>` (e.g. `session.created`), each with a Zod payload schema and a `webhook` flag.
      `recordChange` throws on a type not listed here
- [ ] Provisioning document keys → `packages/homileo-sdk/src/provisioning/schema.ts`, and the
      validation in `src/utils/provisioning/`
- [ ] Webhook event or new permission → `src/definitions/tereoDeclaration.ts`, then
      `npm run tereo:provisioning` and commit `tereo-provisioning.json`
- [ ] Never declare under another app's namespace; app kinds and types are namespaced `app:name`

## Step 2: Database model (`prisma/schema.prisma`)

- [ ] Add the model with `@@schema("chat")` and `@@map("snake_case_table")`; columns get
      `@map("snake_case")`
  - `id String @id @default(uuid(7)) @db.Uuid`
  - `organizationId String @map("organization_id") @db.Uuid` when the row is organization-scoped
    (a tereo id: no foreign key)
  - Actor columns point at `principals`, never at a tereo user
  - `createdAt DateTime @default(now()) @map("created_at") @db.Timestamp(3)`, `updatedAt` likewise
  - Things that are retired get `archivedAt DateTime? @map("archived_at")`
  - `@@index` the foreign keys and the columns lists filter on
- [ ] `npx prisma migrate dev --create-only --name <name>`
- [ ] Append raw SQL only for what Prisma can't express — range partitioning, partial, opclass,
      trigram and GIN indexes, CHECK constraints. On `events`, delete only the PK-reset statement
- [ ] Raw SQL names tables with their schema (`"chat"."messages"`) — there is no `public` schema
- [ ] `npx prisma migrate deploy`, `npx prisma generate`
- [ ] DB functions in `src/utils/db/<resource>.ts` (get, list, create, update, …), each taking an
      optional `tx?: Prisma.TransactionClient`; add the module to `src/utils/db/index.ts`

## Step 3: Access (`src/policy/`)

- [ ] Add or extend the rule in `src/policy/{spaces,sessions,messages}.ts` — the only place access is
      decided. Session access can only narrow the space's access, never widen it
- [ ] If lists or search need it in SQL, extend the "readable sessions" condition and keep it in
      step with the table-driven unit cases (the same cases run against the SQL in `int`)
- [ ] `homileo.chat.admin` cannot read DMs or space-less sessions — keep that true

## Step 4: Routes (`src/routes/`)

Everything is under `routes/v1/`, wired in `routes/v1/index.ts`. Follow the `routes` skill for where
each file goes and the registration order — `tests/conventions/routeLayout.unit.test.ts` enforces
the layout.

- [ ] `schemas.ts` — Zod schemas: bodies, `:id` params, queries
- [ ] `controllers.ts` — handlers
  - `validateBody/validateParams/validateQuery` from `utils/validateReq.ts`
  - `orgCallerOf(req)` from `middleware/auth.ts` for the caller
  - Call `db.<resource>.*` and the policy, not Prisma or an inline check
  - Throw the error classes from `utils/errors.ts`; a session the caller cannot read is a 404
- [ ] `index.ts` — the router. Item routes go in a singular subfolder
      (`Router({ mergeParams: true })`) mounted with `router.use("/:id", …)`
  - `authenticate` and `requireOrganization` on the area router
- [ ] Mount the router in its parent `index.ts`
- [ ] ESM: `.js` on every relative import, directory imports included
- [ ] Imports sorted by the repo rule — `npm run sort-imports`

## Step 5: Record the change — in the transaction

- [ ] Wrap each mutation in `db.$transaction(async (tx) => { … })`
- [ ] `recordChange(tx, { type, organizationId, spaceId?, sessionId?, actorId, entity, payload, audit? })`
      from `utils/changes.ts`, last in the transaction
- [ ] After commit, publish the returned event to the socket layer (best-effort)
- [ ] No fire-and-forget calls for anything that must happen

## Step 6: OpenAPI (`openapi/`, from plan 2)

- [ ] Path file `openapi/paths/<area>/<resource>.yaml`, schemas in
      `openapi/components/<area>/schemas.yaml`, referenced from `openapi/openapi.yaml`
- [ ] Every operation declares `security`; webhook definitions for new webhook events
- [ ] `npm run openapi:build` from `packages/homileo`

## Step 7: Tests (`src/tests/`)

- [ ] `src/tests/routes/<URL path>/<folder>.test.ts`, plus `.validation.unit` and `.permissions`
      files as `src/tests/README.md` says; tags one per line
- [ ] SDK test tokens: `test-token-<uuid>|org=<uuid>|perms=a,b` (a service account:
      `test-token-<uuid>|client=<uuid>`, same UUID twice) — no hand-made auth shortcuts
- [ ] Cover: create, read, update, archive, list with cursor pagination
- [ ] Cover: 403 without the permission, 400 on bad input, 404 on unknown or unreadable ids,
      and another organization's token seeing nothing
- [ ] Assert the event row and the outbox row (and that a rollback leaves neither)
- [ ] Policy rules get table-driven unit tests in `tests/policy/`
- [ ] Clean up what the file creates

## Step 8: SDK client (plan 5 onward) — if apps need it

- [ ] Request and client method in `packages/homileo-sdk/src/`; tests alongside
- [ ] `npm run version-plan` — the SDK is a released library

## Step 9: Documentation

- [ ] `packages/homileo/docs/{provisioning,events,access}.md` as the feature touches them
- [ ] Root `CLAUDE.md` / `README.md` if layout, conventions or *Current state* changed

## Step 10: Finalize

- [ ] `npm run format` and `npm run sort-imports`
- [ ] `npm run lint` and `npm run check`
- [ ] `npm run test:unit` plus the feature's own `int` files in `packages/homileo` (the full suite
      runs in CI, or once at the end with `docker/test/run.sh`); `npx nx run @homileo-io/sdk:test`
      if the SDK changed
- [ ] `npm run version-plan` if `@homileo-io/sdk` or `homileo` changed
