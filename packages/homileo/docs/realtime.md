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
  `organization_required`, `forbidden` (a token without `homileo.spaces.read`, which
  `homileo.spaces.write` and `homileo.chat.admin` include), `too_many_connections`, `connection_closed` (the connection closed
  while the handshake was checked), `shutting_down`, `temporarily_unavailable` (the database was
  too busy, as REST's `503`; retry) or `server_error`.
- The server removes `auth.token` from the handshake once it has read it, so the handshake that
  other nodes receive in a cross-node `fetchSockets` reply over Redis carries no token.
- A socket belongs to the token's organization and sees nothing of another.
- At most 20 sockets per principal per node. Packets over 16 KiB close the connection.
- The socket closes when the token's `exp` passes. The client reconnects with a fresh token, which
  refreshes the permissions the socket is judged by.
- Every 60 s each node introspects its sockets' tokens again through tereo, once per distinct
  token. At most 10 run at once, each starting as soon as one finishes, and their starts are
  paced evenly over the first 30 s of the round, so tereo sees no burst. A round still running
  when the next is due skips that one. A token tereo no longer accepts (revoked, expired, or
  tereo unreachable, as a request would then get `401`) closes its sockets; a token without
  `exp` is closed this way, never by expiry. So does a token that no longer holds
  `homileo.spaces.read`, so every socket action runs for a caller with read. A token still active
  gives its sockets its current permissions, and those whose permissions changed (in any order: a
  reordering is no change) are re-checked. With tereo's introspection
  cache (60 s), a revoked token's sockets close within about two minutes. On shutdown the node
  starts no further introspection and waits up to 5 s for those in flight.
- **Scale bound of the re-check.** A round takes at least `tokens × latency / 10`. At 50 ms per
  introspection that is 12,000 distinct tokens per node in 60 s; past about 6,000 (the 30 s
  pacing span) or with a slower tereo, a round outlasts its pacing, the next round is skipped,
  and a revoked token's sockets take correspondingly longer to close (one round plus tereo's
  cache). Add replicas, or raise the concurrency, before a node holds that many tokens.
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

| Room                                      | Holds                                        | Joined by                                                                                       |
| ----------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `user:<organizationId>:<principalId>`     | every socket of a principal                  | connecting                                                                                      |
| `space:<spaceId>`                         | sockets that follow a space                  | a member who can read the space, on connect and when added; or `subscribe { spaceId }`          |
| `session:<sessionId>`                     | sockets that follow a session                | a participant who can read the session, on connect and when added; or `subscribe { sessionId }` |
| `spaceof:<spaceId>`                       | every socket in a session room of that space | joined and left with the session rooms                                                          |
| `presence:<organizationId>:<principalId>` | sockets watching that principal              | `presence.watch`                                                                                |

When a member or participant is added, their sockets on the node that fans out join the room at
once, before the event is sent; other nodes' sockets are fetched through the Redis adapter and
joined by socket id, a round trip later. (Not by a join to the principal's personal room: that
comes back to the fanning-out node through Redis too, and could join a socket there after a
later removal had already left it.) All of them are then re-checked, so an add that fans out
after a later removal does not leave the removed principal in the room. A join Redis loses is
made good by the sweep (below).

A socket joined for membership or participation never leaves it on `unsubscribe`; that only undoes
`subscribe`. `unsubscribe` checks participation or membership again after leaving, and joins again
if one was added meanwhile. Joins on connect are loaded in the handshake and reloaded and re-checked once the
socket is up, so a change committed in between is not missed.

A join on being added gives no such guarantee. The socket joins the room when the
`session.participant_added` or `space.member_added` event naming it is fanned out, so events of
that resource committed between the add and the join are not pushed, and no `until` marks where
the room's delivery begins. On receiving either event, the client catches that resource up with
`/sync` (`sessionIds` or `spaceIds` set to it) from a cursor taken before the event, such as its
saved `next`, until `hasMore` is false, dropping ids already applied.

## Client events

Every client event takes an optional ack. An ack is `{ ok: true, … }` or
`{ ok: false, error: { code, message, issues? } }`. Codes: `invalid_request` (with `issues`),
`not_found` (the resource is missing, in another organization, unreadable, or, for typing, not
postable), `forbidden` (typing with a read-only token), `too_many_subscriptions`, `too_many_watched`, `rate_limited`,
`temporarily_unavailable` (the database was too busy, as REST's `503`; retry) and `server_error`. A socket may send 20 client events a second; the rest are dropped and answered
`rate_limited`.

| Event                         | Payload                                        | Ack                                                                |
| ----------------------------- | ---------------------------------------------- | ------------------------------------------------------------------ |
| `subscribe`                   | `{ sessionId }` or `{ spaceId }` (exactly one) | `{ ok: true, until }`                                              |
| `unsubscribe`                 | the same                                       | `{ ok: true }`                                                     |
| `typing.start`, `typing.stop` | `{ sessionId }`                                | `{ ok: true }`                                                     |
| `presence.heartbeat`          | none                                           | `{ ok: true }`                                                     |
| `presence.watch`              | `{ principalIds: string[] }`                   | `{ ok: true, statuses: { [principalId]: "online" \| "offline" } }` |

`subscribe` requires that the caller can read the target now (the same check as the REST route,
[access.md](access.md)). A session subscription also joins that session's `spaceof:` room. A socket
holds at most 200 explicit subscriptions; one already in the room (subscribed or joined for
membership) answers `ok` without counting. A subscription whose room the socket now holds for
participation or membership stops counting: at the cap, the socket's subscriptions are checked
against those before refusing, and the sweep drops them too. After joining, the socket's rooms are re-checked, so a
revocation that committed during the check cannot leave it in the room: the ack is then
`not_found`. `until` in the ack is a sync cursor taken once the socket is in the room, as
`ready`'s is. `unsubscribe` of something not subscribed is `ok`.

## The envelope

The socket.io event name is the event's `type`. The argument is always

```json
{
  "id": "1042",
  "type": "message.created",
  "createdAt": "2026-10-31T09:00:00.000Z",
  "organizationId": "…",
  "spaceId": "…",
  "sessionId": "…",
  "actorId": "…",
  "payload": {}
}
```

`id` is the event id as a decimal string, `spaceId` and `sessionId` are `null` where they do not
apply. The same object is an element of `/sync`'s `events`. Payloads are in [events.md](events.md).

Besides the registry types, the server emits three ephemeral events that are never stored and
have no id (they are not part of `/sync`):

- `typing`: `{ sessionId, principalId, typing, expiresInMs: 6000 }`, to the session room, never back
  to the sending socket.
- `presence`: `{ principalId, status: "online" | "offline" }`, to the `presence:` room.
- `unsubscribed`: `{ sessionId }` or `{ spaceId }`, to a socket that lost a room it held by
  `subscribe` other than by `unsubscribe`: a re-check found it can no longer read the resource,
  or a removal left the room (see [Losing access](#losing-access)). The subscription is gone; to
  follow the resource again the client subscribes again. A `subscribe` whose own re-check drops
  the room answers `not_found` instead.

## The audience rule

Sockets and `/sync` use one rule (`src/realtime/audience.ts`). The reader must be able to read the
resource now, and is one of:

- a current participant of the event's session;
- a member of the event's space;
- the principal a targeted event names;
- a subscriber of the resource: a socket subscription, or for `/sync` an id in `sessionIds` or
  `spaceIds`.

More precisely:

- **Space events** (channel `space`) go to `space:<id>`, except join requests below.
- **Join requests** (`space.join_requested`, `space.join_decided`) go to the requester and to the
  sockets in `space:<id>` that, judged by their own token, can moderate the space; `/sync` returns
  them to a member or `spaceIds` subscriber who can moderate it now. The same readers as
  `GET /v1/spaces/:id/join-requests`, which refuses anyone else with `403`.
- **Created events** go to the principals their transaction adds: `session.created` to the personal
  room of each participant added with the session, `space.created` to that of each member added
  with the space. Their joins come later in the transaction, so the session or space room is still
  empty when the created event is sent.
- **Session events** (channel `session`) go to `session:<id>`. `session.created`, `session.updated`
  and `session.archived` of an `access: space` session also go to `space:<id>`. Those of an
  `access: members` session do not, not even to readers of the space who could read the session
  through a kind grant or `homileo.chat.admin`: they hear it by taking part or subscribing.
- **Mentions:** `message.created`, `message.edited` and `message.deleted` also go to the sockets of
  each mentioned user who is still a mention reader of the session (`isMentionReader`: whom
  `canReadSession` admits with no permissions, from current participation, space membership and
  the space's visibility; see [access.md](access.md)) and, judged by the
  socket's own token, can read the session, as `/sync` requires. Mentioned participants get it
  through the session room, which holds their sockets exactly while they can read the session
  (`/sync` likewise returns a participant's event only then); only the other mention readers'
  sockets are fetched, once per committed transaction, from every node. Someone removed since the
  message was written no longer gets it, on the socket or on `/sync`. A delete keeps the mention
  rows, so the readers a message reached through a mention also learn it was deleted.
- **Targeted events** go to the principal they name, on the socket and on `/sync`, whatever that
  principal can currently read: `space.member_added`, `space.member_role_changed`,
  `space.member_removed`, `space.join_requested`, `space.join_decided`,
  `session.participant_added`, `session.participant_removed`, `read.updated` and the revocations.
  Channel `user` events (`read.updated` and the revocations) go to that principal only.
- **Revocations** (`session.access_revoked`, `space.access_revoked`) go to no room. They are
  delivered only to sockets that, re-checked with their own token's permissions, really lost the
  resource, and `/sync` drops one when the reader can still read it. Kind grants count: a
  principal who still reads the resource through one is not told they lost it.
- **Your own send** records no `read.updated`. Your other devices get the `message.created` (you
  are a participant) and treat its `seq` as read for its sender.
- **`/me/unread`** counts mentions from the session's unread messages (`seq > last_read_seq`), not
  from `message_mentions`; `/me/mentions` reads `message_mentions`.

Fan-out runs on the node that committed, on `changeBus`, one transaction after another in the
order their commits completed on that node, and reaches other nodes through the Redis adapter.
Transactions committed on different nodes reach a socket in no guaranteed order between them;
`/sync` returns events in commit order. A failed step is logged and the rest go on.

## Losing access

- **Removal leaves the room.** On `session.participant_removed`, every socket of the removed
  principal, on every node, leaves `session:<id>` (and `spaceof:` once no session room of that space
  remains); on `space.member_removed`, it leaves `space:<id>`. Each is told to leave whether or not
  it appeared in the room, since a join may still be in flight. This holds even when the principal
  can still read the resource (a public space, an `access: space` session, a kind grant), and it
  drops an explicit subscription to it too (with `unsubscribed`): to keep following it, the client
  subscribes again. The removal event itself still reaches them.
- If the removal's or a revocation's fetch of the principal's sockets cannot reach the other
  nodes, this node's sockets are still taken out of the room and re-checked; the other nodes'
  wait for their sweep.
- After a revocation for a principal, every socket of theirs is re-checked, and each `session:` or
  `space:` room it can no longer read is left. A space revocation therefore also drops that space's
  session rooms, and `spaceof:` once no session room of the space remains. The revocation goes to
  each socket of theirs that, judged by its own token, cannot read the resource, whether or not it
  was following it.
- After a `space.updated` that turns a space from `public` to `members` (its payload's
  `previousVisibility` says what it was), the sockets in `space:<id>` and `spaceof:<id>` are
  re-checked before the update is sent, so a socket that lost access with it does not receive it.
  No other update can lock anyone out (a session's `access` cannot be changed), so none other is
  re-checked. If the re-check cannot reach the other nodes, this node's sockets are re-checked and
  only they get the update through those rooms; if that fails too, no socket gets it through them.
- Narrowing visibility records no revocation event: the subscribers it locks out are dropped from
  the room silently. Only removing a member or participant revokes, and only when they cannot read
  the resource any more.
- Every 300 s each node sweeps its local sockets, as a backstop for changes that record no event
  (a kind grant changed by provisioning) and for joins and leaves Redis lost. It loads each
  socket's participation and membership rooms as on connect, joins those it is missing, drops
  the explicit subscriptions they now hold, then re-checks every room. A join it makes is checked
  against a second load, so a removal committed meanwhile is not undone.
- A re-check uses the socket's own caller, so a token's permissions, not the principal's current
  ones, decide kind grants and admin.

## Typing and presence

- **Typing** is for sessions the caller can post in; otherwise `not_found`. A token without
  `homileo.spaces.write` (or `homileo.chat.admin`) is acked `forbidden` before the session is read. `typing.start` is
  throttled to one every 2 s per socket and session (the rest are acked `ok` and not sent); a
  `typing.stop` ends the throttle, so the next start is sent at once. The signal expires after
  `expiresInMs` (6000): a client refreshes it every 3 s while typing, sends `typing.stop` when
  done, and hides the indicator on expiry or on a `message.created` from that sender.
- **Presence** is per organization and by request. `presence.watch { principalIds }` replaces the
  socket's watched set (at most 200, else `too_many_watched`) and acks the current statuses. A
  socket's watches run one at a time, in the order received. Changes
  go out as `presence` events to the watchers. A client sends `presence.heartbeat` every 25 s; a
  principal is offline 60 s after its last heartbeat, when its last socket disconnects, or when the
  30 s sweep finds the entry expired. State is in Redis (`src/utils/presence.ts`), shared by nodes.

## `GET /v1/sync`

`since` takes the `next` of the previous response (`limit` 1 to 500, default 100; `sessionIds` and
`spaceIds` each up to 50 comma-separated ids to subscribe to for this call; `until` the position
the catch-up must reach). It answers

```json
{ "events": [{ "id": "…" }], "next": "<cursor>", "hasMore": false }
```

- **The cursor is opaque.** Event ids come from one sequence but are not in commit order, so "the
  highest id seen" would skip an event that commits late. `next` is base64url JSON of
  `[txId, id, at]`: the transaction id and event id as decimal strings, and the database time in ms
  when it was issued. Events are read in `(txId, id)` order, only from transactions older than
  every transaction still running (`pg_snapshot_xmin`), so a late commit cannot land behind it.
  The cursor is not signed, and a client can make one up (`["0","0",<now>]` pages through the
  whole retained log). That reveals nothing REST does not: events pass the audience rule against what
  the caller can read now, and message events carry the message's current view (below), so an old
  or forged cursor yields no deleted text and no earlier revision. Other events still carry the
  state as of their commit (an earlier session name, a reaction since removed) of resources the
  caller can read now.
- **No `since`** returns `{ events: [], next: <head>, hasMore: false }`; a client starts from there
  (typically before it loads its initial state, so nothing in between is missed).
- **`hasMore`** is true when more matching events remain. A page can be short or empty while later
  events exist, because filtering by audience drops rows after the page is cut; keep calling until
  `hasMore` is false. While `hasMore` is true the cursor's `at` stays that of the cursor sent; it
  refreshes only when a page reaches the horizon.
- **`until`** is the `until` of the socket's `ready`, or of its last `subscribe` ack (each is at
  least as late as the one before). While a transaction older than it is still running, the
  response has `hasMore: true`, even with no events, and `next` holds the progress so far: such a
  transaction may have committed before the socket was in its rooms, so only `/sync` can deliver
  it. Once the horizon has reached `until` and the page drains, `hasMore` is false. An `until`
  past what the database has issued is `400 invalid_request`; without `since` it is ignored.
- **`410 resync_required`** when the cursor's `at` is earlier than the oldest retained partition's
  lower bound, or, once retention has dropped a day, earlier than that bound plus 10 minutes: no
  transaction outlives that margin, so none still open at `at` wrote into a dropped day. Before
  retention has dropped anything (a deploy younger than `EVENT_RETENTION_DAYS`) the margin does not
  apply. Reload state and start again without `since`. A malformed cursor, or one from the
  future (an `at` ahead of the clock, or a `since` or `until` whose transaction id is past what
  the database has assigned, as after a restore onto a new cluster), is `400 invalid_request`.
- Events are filtered by the audience rule above, against what the caller can read now, and by
  organization. Mention parity uses the current mention rows and the reader's current participation
  and membership: an edit that adds or removes a mention changes whether the earlier
  `message.created` is returned. Clients drop events whose `id` they
  have applied.
- **Message events carry the message as it is now.** For `message.created`, `message.edited` and
  `message.deleted` (every event whose payload holds a message view), `/sync` replaces the view
  stored with the event by the message's current view, built as `GET /v1/messages/:id` builds it:
  body, payload, revision and attachments as they stand when the page is read. A deleted
  message's events all carry its deleted view (no body, payload or attachments); an edited
  message's events all carry the latest revision, never an earlier one, so earlier text stays
  limited to `/revisions`. **`reactions` is the exception:** it keeps the summary stored with the
  event, because the `reaction.added` and `reaction.removed` events after it in the log are deltas
  from that summary. A client that applies the events in order (a message event setting the
  summary, each reaction event adding or removing one) ends at the count REST returns; an
  overlaid current summary would count each later reaction twice. Ids, order, types and the
  cursor are unchanged. The current rows are loaded once per page. A message row that no longer
  exists drops its events from the page (Homileo never removes message rows, so this is defensive).
  Live socket events keep the view as of their commit, which is current when they are sent.
- **A page scans at most 5000 rows** of the caller's organization's log, matching or not
  (`MAX_SCANNED_ROWS`). A page cut there returns the matches among them with `hasMore: true` and
  a `next` just past the last row scanned, its `at` that of the cursor sent, so nothing is skipped
  and the cursor always advances. A reader with few relevant events in a busy organization, or a
  made-up cursor from the start of the log, therefore pages through it in bounded requests.

Limits of the implementation:

- `pg_snapshot_xmin` is cluster-wide. Any open write transaction on the Postgres server holds the
  catch-up back until it ends: a shared server, an idle-in-transaction session, a prepared
  transaction. With `until`, `/sync` answers `hasMore: true` meanwhile and the client waits; a
  reconnect therefore takes as long as the oldest such transaction. Live delivery on the socket
  does not wait.
- A sparse reader still costs one request per 5000 rows of its organization's log, each mostly
  filtered out.

## Reconnecting

The socket is connected and buffering before `/sync` starts, and `/sync` runs until it reaches
the position the server gave the socket, so nothing falls between them.

```ts
let cursor = loadSavedCursor(); // the last `next`, or from /sync with no since
const applied = new Set<string>(); // ids already applied, bounded by cursor age

socket.on("ready", async ({ until }) => {
  // Socket events are kept aside, in order, from the moment the socket connects.
  try {
    // Explicit subscriptions are gone after a reconnect.
    for (const target of subscriptions) {
      const ack = await socket.emitWithAck("subscribe", target);
      if (ack.ok) until = ack.until; // each is at least as late as the one before
    }
    for (;;) {
      const page = await sync({ since: cursor, until, sessionIds, spaceIds });
      page.events.forEach(apply);
      cursor = page.next;
      if (!page.hasMore) break;
      if (page.events.length === 0) await sleep(100 + Math.random() * 150);
    }
  } catch (e) {
    if (e.status === 410) return reloadEverything(); // resync_required
    throw e;
  }
  for (const e of buffered) apply(e); // after /sync, skipping seen ids
  stopBuffering();
});

const apply = (e) => {
  if (applied.has(e.id)) return;
  applied.add(e.id); /* update state */
};
```

Pass the subscribed resources in `sessionIds`/`spaceIds` so `/sync` covers what they missed. An
empty page with `hasMore` means an older transaction is still open: back off briefly and call
again. After a long gap, or on `410`,
reload state from the REST routes instead. Events pushed on the socket carry no cursor; keep the
`next` from `/sync`, since socket events do not advance it.
