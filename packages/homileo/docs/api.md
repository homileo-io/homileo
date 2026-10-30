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
