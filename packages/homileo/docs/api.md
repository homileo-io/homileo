# API conventions

The reference is the OpenAPI spec (`openapi/openapi.yaml`, bundled to `openapi/bundled-openapi.yaml`
by `npm run openapi:build`). This page records the rules every route follows; the spec repeats
them where a route is concerned.

## Requests

- Every `/v1` route needs a tereo access token with an organization (`org_id`): `401` without a
  token, `400 organization_required` with one that has no organization. No header names an
  organization. `routes/routes.permissions.test.ts` checks both for every route.
- Only `POST /v1/spaces` needs a tereo permission (`homileo.spaces.write`). The rest are open to
  any signed-in caller and decided by `src/policy/` (see [access.md](access.md)).
- An id that does not parse as a UUID is `400 invalid_request`.
- JSON bodies are limited to 256 KiB on `/v1/sessions` and `/v1/messages`, 64 KiB elsewhere.

## The 404 rule

A space, session or message that does not exist, is in another organization, or that the caller
cannot read answers `404 not_found` with the same message in each case, so a caller cannot tell
them apart. `403` is only for a caller who can read the resource but may not do the action.
`utils/access.ts` (`readableSpace`, `readableSession`, `readableMessage`) is where this is applied;
a route does not decide it itself.

A participant who has left a session counts as no participant. A space whose kind row is gone is
treated as the built-in kind, and a warning is logged. A retired kind stays readable.

## Errors

The body is `{ "error": "<code>", "error_description": "<text>", ...details }`. Validation is
`400 invalid_request` with `issues: [{ path, message }]`. Codes:

| Status | Code |
|---|---|
| 400 | `invalid_request`, `organization_required`, `kind_not_found`, `setting_not_overridable`, `invalid_state`, `message_type_not_found`, `invalid_payload`, `reply_to_reply`, `attachment_not_found`, `attachment_not_uploaded`, `cannot_dm_self` |
| 401 | `unauthorized` |
| 403 | `forbidden`, `posting_restricted`, `not_a_participant`, `edit_window_closed` |
| 404 | `not_found` |
| 409 | `already_archived`, `resource_archived`, `duplicate_client_message` (the body also carries `message`), `last_owner`, `external_ref_taken`, `managed_by_provisioning` |

`resource_archived` is a change to something archived; `already_archived` is archiving it again.

## Pagination

Lists take `limit` (default 50, at most 100) and an opaque `cursor`, and answer
`{ data, nextCursor }`; `nextCursor` is `null` on the last page. The cursor is the base64url of a
JSON array of the sort key's values (`utils/cursor.ts`); one that does not decode, or has the wrong
number of values, is `400 invalid_request`.

Messages page by `seq` instead: `GET /v1/sessions/:id/messages` takes at most one of `before`,
`after` and `around` (integers ≥ 0) and answers `{ data, hasBefore, hasAfter }`, top-level messages
ascending. `around=n` returns up to `limit / 2` on each side of `n`, `n` included (an odd `limit`'s
extra one on the newer side).

## Limits

| What | Limit |
|---|---|
| message `body` | 40,000 characters |
| message `payload` | 64 KiB serialized |
| `metadata` (spaces, sessions, messages) | a flat object of at most 50 keys, each matching `^[A-Za-z][A-Za-z0-9_.-]{0,63}$`, at most 16 KiB serialized (`utils/metadata.ts`); values may be any JSON |
| `clientMessageId` | 1 to 128 characters |
| `emoji` | 1 to 64 characters |
| attachments per message | 10 |
| unread counts | capped at 99: `unread` is 0 to 99, with `unreadCapped: true` past it |

## JSON shapes

Ids are strings. `seq`, `lastSeq` and `lastReadSeq` are JSON numbers. Timestamps are ISO 8601
strings. Event ids are strings.

## Mutations

Every mutation runs in `withChanges` (`utils/transaction.ts`) and records its events there with
`record`. After the transaction commits, the events go out together on `changeBus` as `committed`; a
rollback sends none, and a failing listener is logged without failing the request. A request that
changes nothing (an idempotent repeat) records nothing.

A mutation loads what it checks inside its transaction with `{ tx, lock: true }`, which takes the
session (or space) row `FOR UPDATE`, so the checks and the write see the same rows. Creating a space
reads its kind with `activeKind` (`FOR SHARE`); provisioning takes the kind's row `FOR UPDATE`
before it counts the unarchived spaces of a kind it retires, so a space is never created in a kind
as it retires.

Kinds are cached in the process for 60 seconds and dropped when provisioning applies
(`invalidateKinds`). So are message types' compiled payload schemas (`utils/messageTypes.ts`); a
type not in the cache is read from the database when a message uses it.

A send takes the session row `FOR UPDATE` first (`readableSession({ lock: true })`) and looks up
its `clientMessageId` under that lock, so of two concurrent sends with the same id one inserts and
the other answers `409 duplicate_client_message` without using a `seq`. `seq` comes from
`UPDATE sessions SET last_seq = last_seq + 1 … RETURNING last_seq`, so it is gap-free.

An edit or delete takes the message's space row, then its session row, `FOR UPDATE`
(`readableMessage({ lock: true })`), and re-reads the message under them. An edit that changes the
`body` or `payload` inserts `message_revisions` row `revision + 1` (revision 1 is the original, written
on send), rewrites `message_mentions` and emails only the readers newly mentioned; a `metadata`-only
change makes no revision but still records `message.edited`, and an edit that changes nothing records
nothing. A delete clears `body`, `body_text` and `payload`, keeps revisions, reactions and attachments
(views show the last two as empty), and lowers a reply's root `reply_count`.
`GET /v1/messages/:id/revisions` is for the sender and for whoever can moderate the message's space: any other reader gets `403`, so a
deleted message's text does not reach everyone in the session.

## Routes

Every route is under `/v1`. "Policy" is the `src/policy/` function that decides the action, after
`readableX` has answered `404` for what the caller cannot read. Besides the codes listed, any
route can answer `400 invalid_request`, `400 organization_required`, `401`, `413` (body over the
area's limit) and `404 not_found`. Events are recorded in the request's transaction.

### Platform and principals

| Route | Policy | Errors | Events |
|---|---|---|---|
| `GET /me` | none | | |
| `GET /me/unread` | readable sessions only: `sessions` for those the caller participates in, `threads` for followed threads in any session the caller can read now, participant or not | | |
| `GET /me/mentions` | readable sessions only; `<!here>`/`<!session>` only where the caller participates | | |
| `GET /principals/:principalId` | none | | |
| `POST /principals/resolve` | none; 1 to 100 unique tereo user ids | | |

### Spaces

| Route | Policy | Errors | Events |
|---|---|---|---|
| `GET /spaces` | `canReadSpace`; `membership` = `member` (default) or `readable` | | |
| `POST /spaces` | needs tereo `homileo.spaces.write` | `403 forbidden`, `400 kind_not_found`, `400 setting_not_overridable`, `400 invalid_state`, `409 external_ref_taken` | `space.created`, `space.member_added` (creator as owner, plus kind bots) |
| `GET /spaces/:spaceId` | `canReadSpace` | | |
| `PATCH /spaces/:spaceId` | `canModerateSpace` | `403`, `409 resource_archived`, `400 setting_not_overridable`, `400 invalid_state`, `409 external_ref_taken` | `space.updated` |
| `POST /spaces/:spaceId/archive` | `canManageSpace` | `403`, `409 already_archived` | `space.archived` |
| `POST /spaces/:spaceId/join` | `joinSpaceOutcome` | `403` (`invite`), `409 resource_archived` | `space.member_added`, or `space.join_requested` for `request` |
| `GET /spaces/:spaceId/members` | `canReadSpace` | | |
| `PUT /spaces/:spaceId/members/:principalId` | `canChangeMember` | `403`, `404` unknown principal, `409 last_owner`, `409 resource_archived` | `space.member_added` or `space.member_role_changed` |
| `DELETE /spaces/:spaceId/members/:principalId` | `canChangeMember` (anyone may leave, even an archived space) | `403`, `404`, `409 last_owner`, `409 resource_archived` (someone else, in an archived space) | `space.member_removed`, `session.participant_removed`, `space.access_revoked`, `session.access_revoked` |
| `GET /spaces/:spaceId/join-requests` | `canModerateSpace`; items embed `principal` | `403` | |
| `POST /spaces/:spaceId/join-requests/:principalId/approve`, `/deny` | `canModerateSpace` | `403`, `404`, `409` already decided, `409 resource_archived` | `space.join_decided`, plus `space.member_added` on approval |

`description` is at most 10,000 characters (or `null`). A space's `kind` defaults to the built-in
kind; `externalRef` is unique per kind within the organization.

### Sessions

| Route | Policy | Errors | Events |
|---|---|---|---|
| `GET /sessions` | `canReadSession` per row; filters `spaceId`, `type`, `externalRef`, … | | |
| `POST /sessions` | `canCreateSessionIn` in a space; open for a space-less group | `403 forbidden`, `403 posting_restricted` (a space whose `postPolicy` is `moderators`), `409 resource_archived`, `400 invalid_state` (a `state` on a space-less group, or one the kind does not declare) | `session.created`, `space.member_added` for kind bots missing from the space |
| `POST /sessions/direct` | open; at most one DM per pair | `400 cannot_dm_self`, `404` unknown principal | `session.created` (once; a repeat records nothing) |
| `GET /sessions/:sessionId` | `canReadSession` | | |
| `PATCH /sessions/:sessionId` | `canEditSessionSettings` | `403`, `409 resource_archived`, `400 invalid_state` | `session.updated` |
| `POST /sessions/:sessionId/archive` | `canArchiveSession` | `403`, `409 already_archived` | `session.archived` |
| `GET /sessions/:sessionId/participants` | `canReadSession` | | |
| `PUT /sessions/:sessionId/participants/:principalId` | `canJoinSession` (self) or `canAddParticipant` | `403`, `404` unknown principal, `400` for a non-member of a space, `409 resource_archived` | `session.participant_added`, `space.member_added` when joining through an open space |
| `DELETE /sessions/:sessionId/participants/:principalId` | `canLeaveSession` (self, even when archived) or `canRemoveParticipant` | `403`, `404`, `409 resource_archived` (someone else, in an archived session or space) | `session.participant_removed`, `session.access_revoked` |
| `PUT /sessions/:sessionId/read` | participant | `403 not_a_participant` | `read.updated` |
| `PUT /sessions/:sessionId/notify` | participant | `403 not_a_participant` (also when a leave commits first) | |
| `POST /sessions/:sessionId/attachments` | `postRefusal` | `403`, `409 resource_archived`, `503 temporarily_unavailable` | |
| `GET /sessions/:sessionId/messages` | `canReadSession` | `400` for more than one of `before`, `after`, `around` | |
| `POST /sessions/:sessionId/messages` | `postRefusal` | `403 not_a_participant`, `403 posting_restricted`, `409 resource_archived`, `409 duplicate_client_message`, `400 message_type_not_found`, `400 invalid_payload`, `400 reply_to_reply`, `400 attachment_not_found`, `400 attachment_not_uploaded`, `503` | `message.created`, then `thread.updated` for a reply |

A DM is created with `type: "direct"` and a deterministic `direct_key`, so two concurrent requests
for the same pair produce one session. A session's `externalRef` is not unique, so `PATCH` never
answers `external_ref_taken`.

An attachment's upload URL stays valid until it expires (15 minutes), and the bytes behind it can be
replaced through it until then, even after a message names the attachment. Pinning the version a
message was sent with is planned.

### Messages and threads

| Route | Policy | Errors | Events |
|---|---|---|---|
| `GET /messages/:messageId` | `canReadSession` | | |
| `PATCH /messages/:messageId` | `canEditMessage` | `403`, `403 edit_window_closed`, `409 resource_archived` (deleted message, archived session or space), `400 invalid_payload` | `message.edited` |
| `DELETE /messages/:messageId` | `canDeleteMessage` | `403`, `409 resource_archived` | `message.deleted`, then `thread.updated` for a reply |
| `GET /messages/:messageId/revisions` | sender, or `canModerateSpace` | `403` | |
| `GET /messages/:messageId/thread` | `canReadSession` | `400 reply_to_reply` for a reply | |
| `PUT /messages/:messageId/reactions/:emoji` | `canReact` | `403 not_a_participant`, `409 resource_archived` | `reaction.added` (a repeat records nothing) |
| `DELETE /messages/:messageId/reactions/:emoji` | `canReact` | `403`, `404` not reacted | `reaction.removed` |
| `GET /messages/:messageId/attachments/:attachmentId` | `canReadSession` | `404`, `503` | |
| `PUT /threads/:rootId/read` | `canReadSession` (a reader may track a thread) | `400 reply_to_reply` | `read.updated` |
| `PUT /threads/:rootId/follow` | `canReadSession`; takes the session lock, as a thread read does | `400 reply_to_reply` | |

## Decisions the routes fix

- **9. Read position on send.** Sending a top-level message moves the sender's `last_read_seq` to it;
  a reply moves the sender's thread `last_read_seq`. Your own messages are never unread. This
  records no `read.updated`.
- **10. Mentions.** `<@id>` mentions are stored only for principals who can read the session (see
  [access.md](access.md)) and emailed through `core.outbox.notify` unless their `notify` is `none`
  or they are the sender or a bot. A reply makes its sender a follower and creates a following row
  for the root's sender if none exists; an existing row (an unfollow) is left alone.
  `<!here>` and `<!session>` are stored, so they appear in `/me/mentions` for participants, and send
  no email.
- **11. Attachments.** `POST /v1/sessions/:id/attachments` creates an empty placeholder object in
  `homileo-attachments` under `sessions/<sessionId>/<principalId>/<uuid>` with `deleteAfter` = now +
  24 h, and returns a presigned write URL for the object's id. A message names the object id. The
  send fetches the objects from tereo before its transaction, then checks inside it the key prefix
  (this session, this sender) and `sizeBytes > 0`, and clears `deleteAfter` after commit.
  Unreferenced placeholders expire by themselves. `GET /v1/messages/:messageId/attachments/:attachmentId`
  returns a presigned read URL. A tereo failure on these routes, other than a 404, is
  `503 temporarily_unavailable`.
- **12. Unknown resources.** An id that does not parse as a UUID is `400 invalid_request`; a
  well-formed id the caller cannot read is `404`. Ids from a request are lower-cased at parse time.

## Details

- **Body limits.** JSON bodies are parsed per area in `routes/v1/index.ts`: 256 KiB on `/sessions`
  and `/messages`, 64 KiB on `/principals`, `/spaces` and `/threads`. A larger body is `413`.
- **Listing sessions by `externalRef` without `spaceId`** fetches up to 1,000 matches in the
  organization, keeps those the caller can read, returns the first `limit` and `nextCursor: null`.
- **Lock order** in every mutation: the space row, then the session row, then other rows (see
  [access.md](access.md)).
