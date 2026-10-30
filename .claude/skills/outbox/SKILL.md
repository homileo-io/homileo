---
name: outbox
description: Homileo's write path — recordChange (the event row plus tereo's transactional outbox rows for webhooks and audit), adding an event type, and the outbox reaper. Use when writing a mutation that must emit an event, adding or changing an event type, touching event partitions, or wiring the tereo outbox.
paths:
  - packages/homileo/src/routes/**
  - packages/homileo/src/jobs/**
  - packages/homileo/src/utils/changes.ts
  - packages/homileo/src/utils/partitions.ts
  - packages/homileo/src/utils/db/events.ts
  - packages/homileo/src/utils/tereo.ts
  - packages/homileo/src/worker.ts
  - packages/homileo/src/definitions/tereoDeclaration.ts
  - packages/homileo-sdk/src/events/**
---

# Transactional Writes — Events, Webhooks and Audit

Homileo records every change **in the transaction that makes it**, so the event, the webhook and
the audit entry exist exactly when the business write commits, and not at all when it rolls back.
It uses one function for this, `recordChange` (`utils/changes.ts`), on top of `@tereo-io/sdk`'s
`core.outbox` (the table is `core.core_outbox`).

| Piece | Where | What it does |
|---|---|---|
| `chat.events` | Homileo's database, range-partitioned by day | The ordered event log behind realtime and `GET /v1/sync` |
| `core.core_outbox` | Homileo's database (the `core` schema, created by Homileo's migration) | tereo's outbox rows: `webhook` (events → tereo webhooks) and `audit` |
| Reaper | `getTereo().start()` in `createAppServer` (`index.ts`), every role; dispatches only where `outbox.dispatch` is set (`ROLE` not `api`, and not `TEREO_TEST_MODE`) | Claims due outbox rows, sends them to tereo, deletes on success |

tereo's database is not Homileo's, so nothing here writes tereo's tables: both webhook events and
audit entries go through the outbox.

## Mental model

1. **Inside a Prisma transaction**, make the business write, then `recordChange(tx, …)`.
2. `recordChange` validates the payload against `EVENT_TYPES[type].payload` (a Zod schema in
   `@homileo-io/sdk`), inserts the `events` row, and — if the type is a webhook event —
   `tereo.outbox.emit(tx, …)`; and `tereo.outbox.audit(tx, …)` when `audit` is given.
3. **After commit**, the socket layer publishes the event, and tereo's reaper claims due outbox rows
   with `FOR UPDATE SKIP LOCKED`, dispatches each, and **deletes the row on success**. Failures back
   off; after `maxAttempts` the row is **dead-lettered and kept** for replay.
4. **The outbox row id is the idempotency key**, injected by the reaper. A retry after a crash is
   deduplicated by tereo.

## Call-site pattern

```typescript
await prisma.$transaction(async (tx) => {
  const message = await db.messages.create(input, tx);
  await recordChange(tx, {
    type: "message.created",
    organizationId: caller.organizationId,
    spaceId: session.spaceId,
    sessionId: session.id,
    actorId: caller.principalId,
    entity: { type: "Message", id: message.id },
    payload: formatMessage(message),
  });
});
```

`ChangeInput`: `type` (a key of `EVENT_TYPES`), `organizationId`, `spaceId?`, `sessionId?`,
`actorId` (a principal id), `entity` (`{ type, id }`, becomes tereo's `entityType`/`entityId`),
`payload` (parsed with the type's schema), `audit?`
(`{ action: "CREATE" | "UPDATE" | "DELETE", userId, metadata? }`; `userId` must be a UUID, the SDK
refuses anything else now). It returns the `ChangeEvent` (with the `bigint` id) so the
caller can publish it after commit. A payload the type's schema rejects throws `ValidationError`
(400) before anything is written.

- The webhook `data` is `{ ...payload, eventId: String(id) }`, so a payload key `eventId` cannot
  replace the real one; the tereo event type is `homileo.<type>`.
- Audit entries get `organizationId`, `entityType`, `entityId` from the change; the SDK sets
  `source` from the service slug. Pass `audit` only for changes worth an audit trail.
- The outbox calls `webhooks.assertEventType` first, so an event type missing from Homileo's tereo
  declaration throws now, not at dispatch.

## Two key invariants

1. **Inside the transaction**: `recordChange` writes to the same `tx` as the business write. Call it
   last, just before returning from the callback.
2. **Outside the transaction**: side effects with no database write — socket publishes — run after
   `prisma.$transaction` resolves. A failed publish logs and never fails the request; the client
   catches up with `GET /v1/sync?since=`.

## Adding a new event type

1. Add it to `EVENT_TYPES` in `packages/homileo-sdk/src/events/registry.ts` with its Zod payload
   schema and `webhook: true|false` (`read.updated` and other noisy events are not webhooks).
   Names are `<area>.<verb>`.
2. If it is a webhook event it must be in Homileo's tereo declaration: `npm run tereo:provisioning`
   in `packages/homileo`, commit `tereo-provisioning.json` (readable with `homileo.spaces.read`).
3. Use it in `recordChange({ type: "…" })`.
4. Document it in `packages/homileo/docs/events.md` and, once the spec exists, the OpenAPI
   `webhooks:` section.

Removing an event type that webhook subscribers rely on is a breaking change.

## Event partitions

`chat.events` is range-partitioned by day (`events_YYYY_MM_DD`). `ensureEventPartitions()` creates
yesterday through today+7 (9 partitions) and returns how many it ensured; `index.ts` runs it before
listening (API roles), and `jobs/eventPartitions.ts` wraps it for the worker's daily run. It is
idempotent and safe to run concurrently; a locked table makes it give up after
`PARTITION_DDL_LOCK_TIMEOUT_MS` and retry next run. See `packages/homileo/docs/events.md`.
Retention (dropping old partitions, `EVENT_RETENTION_DAYS`) arrives in plan 3.

## Reaper behaviour

tereo's reaper (in `@tereo-io/sdk`) is started by `getTereo().start()` in `createAppServer`
(`index.ts`) for every role and stopped by `stopTereo()`; it dispatches only where the client's
`outbox.dispatch` is set in `utils/tereo.ts` — `ROLE` other than `api`, and never in
`TEREO_TEST_MODE`. Defaults: `pollIntervalMs` 1000, `batchSize` 100, `maxAttempts` 100,
`retryBaseMs` 2000, `maxBackoffMs` 30 min, `claimTtlMs` 5 min. It dispatches `audit` →
`audit.logAsync` and `webhook` → `webhooks.emitAsync`, sequentially within a batch, each with
`idempotencyKey: row.id`. A permanent rejection (a 4xx other than 401, 408, 409, 429) dead-letters
at once; watch for `outbox.dead_letter` logs. **Replay**: clear `dead_lettered_at`, set
`attempts = 0` and `next_attempt_at = NOW()`.

## Delivery semantics

- **At-least-once, deduplicated by tereo** for 24 hours.
- **Unordered.** Webhook subscribers should tolerate reordering. `eventId` is a string; ids follow
  allocation order, not commit order, so it is not a safe ordering or cursor key on its own — see
  `packages/homileo/docs/events.md` for the gap-aware `/sync` cursor. Realtime and `/sync` carry the
  log's order.
- Homileo's service account needs the `audit_writer` and `webhook_publisher` roles (declared in its
  tereo document, approved by a tereo admin) for the reaper's sends to succeed.

## Don't

- **Don't call `recordChange` or `tereo.outbox.*` outside a transaction.** If there is no paired
  write (rare), open a transaction just for the record.
- **Don't use `audit.log` / `webhooks.emit` (or the `Async` variants) for state-changing writes.**
  They are best-effort and bypass the outbox; the reaper is their real caller.
- **Don't emit an event type that isn't in the registry** (and, for webhooks, the declaration).
- **Don't add events to read endpoints** — read state has its own `read.updated` event, written
  when the cursor moves.
- **Don't open `prisma.$transaction` in a controller** — transactions belong to the `utils/db/`
  module that owns the write.

## Common gotchas

- **`TEREO_TEST_MODE`**: tereo is stubbed. The `int` server (started in the vitest main process)
  calls `getTereo().start()`, but test mode turns `outbox.dispatch` off, so no reaper sends anything
  and outbox rows — the server's and the tests' — stay in `core.core_outbox`. A test file runs in a
  worker and calls `initializeTereo()` itself in `beforeAll` (and `stopTereo()` in `afterAll`)
  before `recordChange`; it reads the rows it made and deletes them. The SDK's public
  `processBatch()` drains them deterministically.
- **A rolled-back transaction leaves no event and no outbox row** — `changes.test.ts` asserts this;
  keep it true when refactoring.
- **`created_at` partitions**: an event recorded for a day with no partition fails. The daily job
  creates a week ahead, so this means the worker is down.
