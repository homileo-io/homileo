# Events

Every change in Homileo is an **event**: a row in `chat.events`, written in the same transaction as
the change by `recordChange` (`src/utils/changes.ts`). Realtime pushes, `GET /v1/sync` and webhooks
all carry these events, with the same ids.

## Registry

The event types live in `@homileo-io/sdk` (`EVENT_TYPES`, `packages/homileo-sdk/src/events/registry.ts`),
each with a `channel`, a `webhook` flag and a Zod `payload` schema. A type is named `<area>.<verb>`
in Homileo and `homileo.<area>.<verb>` in tereo.

| Channel | Types | Webhook |
|---|---|---|
| `space` | `space.created`, `space.updated`, `space.archived`, `space.member_added`, `space.member_removed`, `space.member_role_changed`, `space.join_requested`, `space.join_decided` | yes |
| `session` | `session.created`, `session.updated`, `session.archived`, `session.participant_added`, `session.participant_removed`, `message.created`, `message.edited`, `message.deleted`, `reaction.added`, `reaction.removed`, `thread.updated` | yes |
| `user` | `read.updated`, `space.access_revoked`, `session.access_revoked` | no |

The channel says whose realtime channel receives the event. The webhook types are declared to tereo
(`tereo-provisioning.json`), readable with `homileo.spaces.read`.

## Write path

```ts
await prisma.$transaction(async (tx) => {
  const space = await db.spaces.create(input, tx);
  await recordChange(tx, {
    type: "space.created",
    organizationId,
    spaceId: space.id,
    actorId: caller.principalId,
    entity: { type: "Space", id: space.id },
    payload: formatSpace(space),
    audit: { action: "CREATE", userId: caller.tereoUserId },
  });
});
```

`recordChange(tx, change)`:

1. Parses `payload` with the type's schema; a rejected payload throws `ValidationError` and nothing
   is written.
2. Inserts the `chat.events` row and reads back its `id` and `created_at`.
3. If the type is a webhook, `outbox.emit(tx, …)` writes a `core.core_outbox` row with
   `eventType: "homileo.<type>"`, the change's `organizationId`, `entityType`/`entityId` from
   `entity`, and `data: { eventId: String(id), ...payload }`.
4. If `audit` is given, `outbox.audit(tx, …)` writes an audit row with the change's
   `organizationId`, `entityType` and `entityId`; the SDK sets `source` from the service slug.

It returns the event, with its `bigint` id, so the caller can publish it to sockets after commit.
Everything commits or rolls back with the caller's transaction. Ids come from one sequence, so
they increase in allocation order, which is not always commit order.

tereo's reaper sends the outbox rows to tereo after commit, deduplicated by row id.

## Partitions

`chat.events` is range-partitioned by day on `created_at`, with the primary key `(id, created_at)`.
Partitions are named `events_YYYY_MM_DD` (UTC days). An insert for a day with no partition fails.

- `ensureEventPartitions(today?)` (`src/utils/partitions.ts`) creates yesterday through today+7,
  nine partitions, and returns how many it ensured. It is idempotent and safe to run from several
  processes at once.
- `index.ts` runs it before the API listens, so today and tomorrow exist even while the worker is
  down. `src/jobs/eventPartitions.ts` wraps it as the worker's daily job.
- Creating a partition takes a lock on `chat.events`; it waits at most
  `PARTITION_DDL_LOCK_TIMEOUT_MS` (5 s by default) and then leaves the day for the next run.

## Retention

Dropping partitions older than `EVENT_RETENTION_DAYS` (30 by default) arrives in plan 3, with
`GET /v1/sync` and the worker.
