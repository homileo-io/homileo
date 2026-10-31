# Realtime and sync

Events (see [events.md](events.md)) reach clients two ways: pushed on a socket.io server at `/ws`, and
pulled with `GET /v1/sync`. Both carry the same envelope, the same ids and the same audience rule, so
a client can use either and drop the repeats. Sockets are fast and can miss events (a disconnect, a
Redis blip); `/sync` is the gap-free catch-up.

Code: `src/websocket/` (server, rooms, fan-out, ephemeral signals), `src/realtime/` (the audience
rule, room names, the sync cursor), `src/routes/v1/sync/`, `src/utils/presence.ts`.

## Connecting

```ts
const socket = io(baseUrl, { path: "/ws", auth: { token } });
```

- The token is a tereo access token in the handshake's `auth.token`, checked as a request's is. A
  refusal is a `connect_error` whose message is the code: `unauthorized` (missing or bad token),
  `organization_required`, `too_many_connections`, `shutting_down` or `internal_error`.
- A socket belongs to the token's organization and sees nothing of another.
- At most 20 sockets per principal per node. Packets over 16 KiB close the connection.
- The socket closes when the token's `exp` passes. The client reconnects with a fresh token, which
  refreshes the permissions the socket is judged by.
- Connecting counts as a presence heartbeat.
- The server accepts the `websocket` and `polling` transports. Polling sends each request of one
  connection separately, so with more than one api replica behind a load balancer, either route a
  client to the same replica (sticky sessions, e.g. by the `sid` query parameter or a cookie) or
  have clients connect with `transports: ["websocket"]`. One replica needs neither.
- Once its rooms are joined and re-checked, the server sends the socket `ready`:
  `{ until: <sync cursor> }`. Every transaction that starts after `until` was taken fans out to
  the socket's rooms; `until` is where a catch-up through `/sync` must reach (see
  [Reconnecting](#reconnecting)). A socket whose rooms could not be loaded is closed without
  `ready`, and the client reconnects.

## Rooms

| Room | Holds | Joined by |
|---|---|---|
| `user:<organizationId>:<principalId>` | every socket of a principal | connecting |
| `space:<spaceId>` | sockets that follow a space | a member who can read the space, on connect and when added; or `subscribe { spaceId }` |
| `session:<sessionId>` | sockets that follow a session | a participant who can read the session, on connect and when added; or `subscribe { sessionId }` |
| `spaceof:<spaceId>` | every socket in a session room of that space | joined and left with the session rooms |
| `presence:<organizationId>:<principalId>` | sockets watching that principal | `presence.watch` |

A socket joined for membership or participation never leaves it on `unsubscribe`; that only undoes
`subscribe`. Joins on connect are loaded in the handshake and reloaded and re-checked once the
socket is up, so a change committed in between is not missed.

## Client events

Every client event takes an optional ack. An ack is `{ ok: true, … }` or
`{ ok: false, error: { code, message, issues? } }`. Codes: `invalid_request` (with `issues`),
`not_found` (the resource is missing, in another organization, unreadable, or, for typing, not
postable: never `forbidden`), `too_many_subscriptions`, `too_many_watched`, `rate_limited` and
`internal_error`. A socket may send 20 client events a second; the rest are dropped and answered
`rate_limited`.

| Event | Payload | Ack |
|---|---|---|
| `subscribe` | `{ sessionId }` or `{ spaceId }` (exactly one) | `{ ok: true, until }` |
| `unsubscribe` | the same | `{ ok: true }` |
| `typing.start`, `typing.stop` | `{ sessionId }` | `{ ok: true }` |
| `presence.heartbeat` | none | `{ ok: true }` |
| `presence.watch` | `{ principalIds: string[] }` | `{ ok: true, statuses: { [principalId]: "online" \| "offline" } }` |

`subscribe` requires that the caller can read the target now (the same check as the REST route,
[access.md](access.md)). A session subscription also joins that session's `spaceof:` room. A socket
holds at most 200 explicit subscriptions; one already in the room (subscribed or joined for
membership) answers `ok` without counting. `until` in the ack is a sync cursor taken once the
socket is in the room, as `ready`'s is. `unsubscribe` of something not subscribed is `ok`.

## The envelope

The socket.io event name is the event's `type`. The argument is always

```json
{ "id": "1042", "type": "message.created", "createdAt": "2026-10-31T09:00:00.000Z",
  "organizationId": "…", "spaceId": "…", "sessionId": "…", "actorId": "…", "payload": { } }
```

`id` is the event id as a decimal string, `spaceId` and `sessionId` are `null` where they do not
apply. The same object is an element of `/sync`'s `events`. Payloads are in [events.md](events.md).

Besides the registry types, the server emits two ephemeral events that are never stored and have no
id (they are not part of `/sync`):

- `typing`: `{ sessionId, principalId, typing, expiresInMs: 6000 }`, to the session room, never back
  to the sending socket.
- `presence`: `{ principalId, status: "online" | "offline" }`, to the `presence:` room.

## The audience rule

Sockets and `/sync` use one rule (`src/realtime/audience.ts`). The reader must be able to read the
resource now, and is one of:

- a current participant of the event's session;
- a member of the event's space;
- the principal a targeted event names;
- a subscriber of the resource: a socket subscription, or for `/sync` an id in `sessionIds` or
  `spaceIds`.

More precisely:

- **Space events** (channel `space`) go to `space:<id>`.
- **Session events** (channel `session`) go to `session:<id>`. `session.created`, `session.updated`
  and `session.archived` of an `access: space` session also go to `space:<id>`. Those of an
  `access: members` session do not, not even to readers of the space who could read the session
  through a kind grant or `homileo.chat.admin`: they hear it by taking part or subscribing.
- **Mentions:** `message.created` and `message.edited` also go to the personal room of each mentioned
  user (the stored mentions name only principals who could read the session when it was written).
- **Targeted events** go to the principal they name, on the socket and on `/sync`, whatever that
  principal can currently read (R9): `space.member_added`, `space.member_role_changed`,
  `space.member_removed`, `space.join_requested`, `space.join_decided`,
  `session.participant_added`, `session.participant_removed`, `read.updated` and the revocations.
  Channel `user` events (`read.updated` and the revocations) go to that principal only.
- **Revocations** (`session.access_revoked`, `space.access_revoked`) go to no room. They are
  delivered only to sockets that, re-checked with their own token's permissions, really lost the
  resource, and `/sync` drops one when the reader can still read it. This corrects plan 2's
  revocations, which judged the target without their kind grants.
- **Your own send** records no `read.updated`. Your other devices get the `message.created` (you
  are a participant) and treat its `seq` as read for its sender.
- **`/me/unread`** counts mentions from the session's unread messages (`seq > last_read_seq`), not
  from `message_mentions`; `/me/mentions` reads `message_mentions` (R7).

Fan-out runs per node on `changeBus`, one committed transaction after another in commit order, and
reaches other nodes through the Redis adapter. A failed step is logged and the rest go on.

## Losing access

- **Removal leaves the room.** On `session.participant_removed`, every socket of the removed
  principal, on every node, leaves `session:<id>` (and `spaceof:` once no session room of that space
  remains); on `space.member_removed`, it leaves `space:<id>`. This holds even when the principal
  can still read the resource (a public space, an `access: space` session, a kind grant), and it
  drops an explicit subscription to it too: to keep following it, the client subscribes again.
  The removal event itself still reaches them.
- After a revocation for a principal, every socket of theirs is re-checked, and each `session:` or
  `space:` room it can no longer read is left. The revocation goes to each socket of theirs that,
  judged by its own token, cannot read the resource, whether or not it was following it. A space revocation therefore also drops that space's
  session rooms, and `spaceof:` once no session room of the space remains.
- After `space.updated` or `session.updated`, the sockets in that resource's room (and `spaceof:`
  for a space) are re-checked before the update is sent, so a socket that lost access with it does
  not receive it. The payload holds only the new state, so the re-check runs only when the new
  state could narrow access: a `members` space, or a `members` session. A `public` space or an
  `access: space` session cannot lock anyone out and is not re-checked.
- Narrowing visibility records no revocation event: the subscribers it locks out are dropped from
  the room silently. Only removing a member or participant revokes, and only when they cannot read
  the resource any more.
- Every 300 s each node re-checks all its local sockets, as a backstop for changes that record no
  event (a kind grant changed by provisioning).
- A re-check uses the socket's own caller, so a token's permissions, not the principal's current
  ones, decide kind grants and admin.

## Typing and presence

- **Typing** is for sessions the caller can post in; otherwise `not_found`. `typing.start` is
  throttled to one every 2 s per socket and session (the rest are acked `ok` and not sent); a
  `typing.stop` ends the throttle, so the next start is sent at once. The signal expires after
  `expiresInMs` (6000): a client refreshes it every 3 s while typing, sends `typing.stop` when
  done, and hides the indicator on expiry or on a `message.created` from that sender.
- **Presence** is per organization and by request. `presence.watch { principalIds }` replaces the
  socket's watched set (at most 200, else `too_many_watched`) and acks the current statuses. Changes
  go out as `presence` events to the watchers. A client sends `presence.heartbeat` every 25 s; a
  principal is offline 60 s after its last heartbeat, when its last socket disconnects, or when the
  30 s sweep finds the entry expired. State is in Redis (`src/utils/presence.ts`), shared by nodes.

## `GET /v1/sync`

`since` takes the `next` of the previous response (`limit` 1 to 500, default 100; `sessionIds` and
`spaceIds` each up to 50 comma-separated ids to subscribe to for this call; `until` the position
the catch-up must reach). It answers

```json
{ "events": [ { "id": "…" } ], "next": "<cursor>", "hasMore": false }
```

- **The cursor is opaque** (Decision 1). Event ids come from one sequence but are not in commit
  order, so "the highest id seen" would skip an event that commits late. `next` is base64url JSON of
  `[txId, id, at]`: the transaction id and event id as decimal strings, and the database time in ms
  when it was issued. Events are read in `(txId, id)` order, only from transactions older than
  every transaction still running (`pg_snapshot_xmin`), so a late commit cannot land behind it.
- **No `since`** returns `{ events: [], next: <head>, hasMore: false }`; a client starts from there
  (typically before it loads its initial state, so nothing in between is missed).
- **`hasMore`** is true when more matching events remain. A page can be short or empty while later
  events exist, because filtering by audience drops rows after the page is cut; keep calling until
  `hasMore` is false. While `hasMore` is true the cursor's `at` stays that of the cursor sent
  (R8); it refreshes only when a page reaches the horizon.
- **`until`** is the `until` of the socket's `ready`, or of its last `subscribe` ack (each is at
  least as late as the one before). While a
  transaction older than it is still running, the response has `hasMore: true`, even with no
  events, and `next` holds the progress so far: such a transaction may have committed before the
  socket was in its rooms, so only `/sync` can deliver it. Once the horizon has passed `until` and
  the page drains, `hasMore` is false. An `until` past what the database has issued is
  `400 invalid_request`; without `since` it is ignored.
- **`410 resync_required`** when the cursor's `at` is earlier than the oldest retained partition's
  lower bound, or, once retention has dropped a day, earlier than that bound plus 10 minutes: no
  transaction outlives that margin, so none still open at `at` wrote into a dropped day. Before
  retention has dropped anything (a deploy younger than `EVENT_RETENTION_DAYS`) the margin does not
  apply. Reload state and start again without `since`. A malformed cursor, or one from the future, is `400 invalid_request`.
- Events are filtered by the audience rule above, against what the caller can read now, and by
  organization. Mention parity uses the current mention rows: an edit that adds or removes a mention
  changes whether the earlier `message.created` is returned. Clients drop events whose `id` they
  have applied.

Limits of the implementation:

- `pg_snapshot_xmin` is cluster-wide. Any open write transaction on the Postgres server holds the
  catch-up back until it ends: a shared server, an idle-in-transaction session, a prepared
  transaction. With `until`, `/sync` answers `hasMore: true` meanwhile and the client waits; a
  reconnect therefore takes as long as the oldest such transaction. Live delivery on the socket
  does not wait.
- `limit` caps the matches, not the rows scanned: a reader with few relevant events in a busy
  organization can make `/sync` scan many rows.

## Reconnecting

The socket is connected and buffering before `/sync` starts, and `/sync` runs until it reaches
the position the server gave the socket, so nothing falls between them (Decision 2).

```ts
let cursor = loadSavedCursor();           // the last `next`, or from /sync with no since
const applied = new Set<string>();        // ids already applied, bounded by cursor age

socket.on("ready", async ({ until }) => {
  // Socket events are kept aside, in order, from the moment the socket connects.
  try {
    // Explicit subscriptions are gone after a reconnect.
    for (const target of subscriptions) {
      const ack = await socket.emitWithAck("subscribe", target);
      if (ack.ok) until = ack.until;     // each is at least as late as the one before
    }
    for (;;) {
      const page = await sync({ since: cursor, until, sessionIds, spaceIds });
      page.events.forEach(apply);
      cursor = page.next;
      if (!page.hasMore) break;
      if (page.events.length === 0) await sleep(100 + Math.random() * 150);
    }
  } catch (e) {
    if (e.status === 410) return reloadEverything();   // resync_required
    throw e;
  }
  for (const e of buffered) apply(e);     // after /sync, skipping seen ids
  stopBuffering();
});

const apply = (e) => { if (applied.has(e.id)) return; applied.add(e.id); /* update state */ };
```

Pass the subscribed resources in
`sessionIds`/`spaceIds` so `/sync` covers what they missed. An empty page with `hasMore` means an
older transaction is still open: back off briefly and call again. After a long gap, or on `410`,
reload state from the REST routes instead. Events pushed on the socket carry no cursor; keep the
`next` from `/sync`, since socket events do not advance it.
