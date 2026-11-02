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

Payloads (strict objects; resource shapes are the SDK's `SpaceSchema`, `SessionSchema`,
`MessageSchema`, `SpaceMemberSchema`, `ParticipantSchema` and `JoinRequestSchema`):

| Type | Payload |
|---|---|
| `space.created`, `space.archived` | `{ space }` |
| `space.updated` | `{ space, previousVisibility }`: the new space, and its `visibility` before the update |
| `space.member_added` | `{ spaceId, member }` |
| `space.member_removed` | `{ spaceId, principalId }` |
| `space.member_role_changed` | `{ spaceId, member, previousRole }` |
| `space.join_requested`, `space.join_decided` | `{ request }` |
| `session.created`, `session.updated`, `session.archived` | `{ session }` |
| `session.participant_added` | `{ sessionId, participant }` |
| `session.participant_removed` | `{ sessionId, principalId }` |
| `message.created`, `message.edited`, `message.deleted` | `{ message }` |
| `reaction.added`, `reaction.removed` | `{ sessionId, messageId, principalId, emoji }` |
| `thread.updated` | `{ sessionId, rootId, replyCount, lastReplyAt }` |
| `read.updated` | `{ principalId, sessionId, threadRootId, lastReadSeq }` |
| `space.access_revoked` | `{ principalId, spaceId }` |
| `session.access_revoked` | `{ principalId, sessionId }` |

The stored `{ message }` is the view at commit, and sockets and webhooks deliver it as stored.
`/sync` instead returns each message event with the message's current view, as REST shows it now
(a deleted message's deleted view, an edited one's latest revision): see
[realtime.md](realtime.md#get-v1sync).

`message.created` and `message.deleted` of a reply are recorded before the reply's `thread.updated`,
so a consumer never sees a `replyCount` for a reply it has not received.

The channel says whose realtime channel receives the event. The webhook types are declared to tereo
(`tereo-provisioning.json`), readable with `homileo.spaces.read`.

A `session` channel event of a **private session** (`isPrivateSession`: no space, or
`access: members`) leaves under its own name, `homileo.private_<area>.<verb>`
(`homileo.private_message.created`, `homileo.private_session.updated`, …;
`webhookEventName` and `privateWebhookEventTypes` in the SDK). Those types are readable only with
`homileo.messages.read_private`, which nothing else implies, `homileo.chat.admin` included: tereo
sends a webhook an event only when the user who created it holds the type's read permission, and
it checks nothing per session. So a holder of `homileo.spaces.read` receives the events of every
`access: space` session in the organization, even of spaces it is not a member of, and none of a
DM's.

## Write path

```ts
await withChanges(async (tx, record) => {
  const space = await tx.space.create({ data });
  await record({
    type: "space.created",
    organizationId: space.organizationId,
    spaceId: space.id,
    actorId: caller.principalId,
    entity: { type: "space", id: space.id },
    payload: { space: spaceView(space) },
    audit: { action: "CREATE", userId: caller.tereoUserId },
  });
});
```

`recordChange(tx, change)`:

1. Parses `payload` with the type's schema. The server built it, so a rejected payload throws a
   plain `Error` (a 500) and nothing is written.
2. Inserts the `chat.events` row and reads back its `id` and `created_at`.
3. If the type is a webhook, `outbox.emit(tx, …)` writes a `core.core_outbox` row with
   `eventType: "homileo.<type>"` (`"homileo.private_<type>"` for a private session's event), the change's `organizationId`, `entityType`/`entityId` from
   `entity`, and `data: { ...payload, eventId: String(id) }` (the real id wins over a payload key).
4. If `audit` is given, `outbox.audit(tx, …)` writes an audit row with the change's
   `organizationId`, `entityType` and `entityId`; the SDK sets `source` from the service slug.

It returns the event, with its `bigint` id, so the caller can publish it to sockets after commit.

`recordChanges(tx, changes)` (`record.many` in `withChanges`) does the same for many changes in a
fixed number of statements: every payload is parsed first, then one `INSERT … SELECT FROM unnest`
writes the events (ids in the order given), the session access behind the private webhook names is
read once, and the SDK's `emit` and `audit` rows go into the outbox in one more insert
(`utils/db/outbox.ts` collects the rows the SDK builds). A change that records one event per
session, such as removing a space member, uses it, so thousands of sessions fit in
`DB_TRANSACTION_TIMEOUT_MS`. `recordChange` is the one-change case.
Everything commits or rolls back with the caller's transaction. Ids come from one sequence, so
they increase in allocation order, which is not always commit order: an event can become visible
after one with a higher id. A `/sync` cursor that is only "the highest id seen" would then skip it,
so `/sync` reads in commit order, behind the oldest running transaction, with an opaque cursor
(see [realtime.md](realtime.md)). Ids are `bigint` inside Homileo and leave the process as strings.

After the transaction commits, `withChanges` puts the committed events on `changeBus`
(`src/utils/changeBus.ts`) in record order; a rollback publishes none. The realtime layer
(`src/websocket/fanout.ts`) subscribes to it and pushes to sockets. `message.created` advances its
sender's read position (the move on send records no `read.updated`), and `space.access_revoked`
revokes every session subscription in that space (`session.access_revoked` is sent only for
sessions the principal participated in).

## The envelope

On a socket and in `/sync`, an event is `{ id, type, createdAt, organizationId, spaceId,
sessionId, actorId, payload }`, with `id` a decimal string (`src/views/event.ts`). The channel
and the payload decide who receives it ([realtime.md](realtime.md)): `space.join_requested` and
`space.join_decided` are channel `space` but reach only the requester and the space's moderators,
and `session.created` and `space.created` also reach the participants or members their transaction
adds. Revocations are re-checked
before delivery: a socket gets one only if it really lost the resource, and `/sync` drops one when
the reader can still read it.

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
  While it waits, inserts into `chat.events` queue behind it, so a long read on the table can
  hold every write up to that long. Dropping a partition for retention does the same.
- `actor_id` has no foreign key to `chat.principals`: a partition's copy of one would lock
  `chat.principals` on every create, detach and drop (exclusively on drop). Principals are never
  deleted, so nothing is lost.
- The migration that adds `tx_id` (`20261031125557_events_tx_id`) rewrites `chat.events` under
  an exclusive lock, blocking writes for as long as that takes on a large table.

## Retention

The worker's daily job (`src/jobs/eventRetention.ts`) drops partitions older than
`EVENT_RETENTION_DAYS` (30 by default). A `/sync` cursor older than the oldest retained partition
(plus a 10-minute margin once retention has dropped a day) is `410 resync_required`.
