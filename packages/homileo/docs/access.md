# Access

Every access check goes through one module of pure functions, `src/policy/` (`canReadSpace`,
`canReadSession`, `canPost`, …). REST routes, socket subscriptions and `/sync` call it with facts the
caller loaded (`SpaceFacts`, `SessionFacts`, `MessageFacts`) and the `OrgCaller` (always has an organization: the token's `org_id`); it does no I/O.
The tests are `src/tests/policy/*.unit.test.ts`, tag `access`.

## Organizations

Every space and session has an `organization_id`, fixed at creation. Every function starts with the
organization: a space or session in another organization is refused whatever the caller's
membership, role, grants or `homileo.chat.admin` (a route turns this into `404`). A session's space
must also be in the session's organization. `public` means any signed-in user of that organization.
Kind grants and `homileo.chat.admin` are checked against the permissions in the caller's token.

## Read permission

Using chat at all needs `canReadChat` (`policy/chat.ts`): the token holds `homileo.spaces.read`
(or anything above it on tereo's ladder: `homileo.spaces.write`, `homileo.spaces.admin`, `admin`)
or `homileo.chat.admin`, named for the same reason as below. `homileo.chat.admin` passes the read
gate as it passes the write gate; it still reads no DM or space-less session, which the rules below
decide.

Every `/v1` route asks it through `requireChatRead` (`middleware/auth.ts`), mounted once on the
`/v1` router after `authenticate`, so a token without it gets `403 forbidden` ("Requires the
homileo.spaces.read permission") before validation or any lookup: every GET, `/v1/sync`,
`/v1/me/*`, the principal lookups, the calls on the caller's own state, and leaving. A permission
off the ladder (`homileo.messages.read_private`, a kind's grant) does not pass it. The socket
handshake refuses such a token with the connect error `forbidden`, and the periodic token
re-check closes the sockets of a token that no longer holds it, so every socket action runs for a
caller with read ([realtime.md](realtime.md)).

## Write permission

Changing shared chat state needs `canWriteChat` (`policy/chat.ts`): the token holds
`homileo.spaces.write` (or anything above it on tereo's ladder: `homileo.spaces.admin`, `admin`) or
`homileo.chat.admin`. `homileo.chat.admin` is named explicitly because it is on another branch
(`homileo.chat`), so the ladder alone would not let an admin token archive a space or remove a
participant. Holding it does not widen anything else: every change still goes through the rules
below (an admin still cannot post in a DM it does not take part in).

The routes ask it through `requireChatWrite` (`middleware/auth.ts`), before validation or any
lookup, so a read-only token gets `403 forbidden` ("Requires the homileo.spaces.write permission")
even for an id it cannot read. Gated:

- spaces: create, `PATCH`, archive, join, member add, change and removal of someone else, join
  request approve and deny;
- sessions: create, direct, `PATCH`, archive, participant add and removal of someone else;
- messages: send, edit, delete; reactions add and remove; attachment placeholders;
- `POST /principals/resolve`, which creates principals for tereo users;
- the socket's `typing.start` and `typing.stop` (a signal other participants see), acked
  `forbidden`.

Reading needs only the read permission, and so do the calls that touch only the caller's own
state: `PUT /sessions/:id/read`, `PUT /sessions/:id/notify`, `PUT /threads/:rootId/read`,
`PUT /threads/:rootId/follow`, plus subscriptions and presence.

Leaving is the one exception that others see: `DELETE /spaces/:id/members/:principalId` and
`DELETE /sessions/:id/participants/:principalId` with the caller's own id are open to a read-only
token, so a principal someone added is never trapped. `canRemoveWithToken(caller, targetId)`
(`policy/chat.ts`) decides it, and those two routes ask it through `requireChatWriteUnlessSelf`,
which reads `:principalId` as the params schema does (lower-cased), so the caller's id in upper
case is still the caller; removing anyone else still needs `canWriteChat`. The leave itself is then
judged by the usual rules (`canChangeMember`, `canLeaveSession`: a DM still cannot be left).

A token with only `homileo.spaces.read` can therefore read, keep its own read state and leave, and
change nothing else others see; a token without it can do nothing. `routes/routes.permissions.test.ts`
checks the read gate on every `/v1` route, lists every route that is not a GET as write-gated or
open to readers, and checks the self-removal exception.

## Read a space

Any of: the caller is a member; `visibility` is `public`; the space's kind grants a permission the
caller holds (grant `read` or `moderate`); the caller has `homileo.chat.admin`.

## Read a session

| Session | Readable by |
|---|---|
| In a space, `access: space` | anyone who can read the space |
| In a space, `access: members` | among those who can read the space: participants, holders of a kind grant, `homileo.chat.admin` |
| No space | participants only (`homileo.chat.admin` cannot read) |

Session access only ever narrows the space's: a session in a space is readable only by someone who
can read the space, participants included. A participant who loses read on the space (a removed
member of a `members` space, a grant holder whose grant is gone) loses every session in it, and
with it posting, reacting and its socket rooms. `readsEverySessionOf` is the `access: members`
branch for non-participants (a kind grant, or admin); the session list's `spaceId` filter uses it
to skip the participation test.

A moderator who is not a space member (a kind grant `moderate`, or `homileo.chat.admin`) can create
a session in the space and becomes its participant without becoming a member. That is deliberate:
the creator is not enrolled in the space, because the read rule above already ends their access
when the grant goes.

The listing `GET /sessions?externalRef=` without `spaceId` applies the same table in SQL, so
sessions the caller cannot read never take a page's places; the policy then checks each row again.
The SQL conditions live in `policy/sql.ts` (`readableSessionWhere`, `readableSpaceWhere`,
`spaceSessionsWhere`): pure Prisma `where` builders that take the kinds whose grants the caller
holds, which `utils/db` loads (`grantedKindsOf`). `tests/policy/sql.test.ts` runs them and the policy
over the same fixtures (members, participants, a left participant, a kind grant, admin, a public
space) and expects the same rows.

A participant who cannot read the session (a grant moderator who created it and lost the grant)
can still leave it and set its `notify`: those routes load the session through the caller's own
current participant row (`actsOnOwnParticipation`, `readableSession(…, { ownParticipation: true })`)
instead of the read check. Nothing else is reachable that way.

## Webhooks

tereo delivers Homileo's webhook events by permission alone: an endpoint gets an event when its
creator holds the event type's read permission in the organization (and `webhooks.read`). It does
not apply the table above. So the events of a private session (`isPrivateSession`: no space, or
`access: members`) leave under separate types, `homileo.private_<area>.<verb>`, readable only with
`homileo.messages.read_private`; every other webhook type is readable with `homileo.spaces.read`.
`homileo.messages.read_private` is granted explicitly, to an integration that must see DMs: no other
permission implies it, `homileo.chat.admin` included. See [events.md](events.md).

## Join and post

- `joinSpaceOutcome`: `join` for an existing member, or `open`; `request` for `request`;
  `forbidden` for `invite`, or when the caller cannot read the space.
- `canJoinSession`: only for an `access: space` session in a space the caller can read. A member of
  the space (or an existing participant) may; a non-member may only when the space's `joinPolicy` is
  `open`, since joining the session also joins the space. `access: members` sessions and space-less
  sessions are joined by being added.
- `canPost`: the caller must be a participant. When the space's `postPolicy` is `moderators`, only
  anyone who can moderate the space (owner, moderator, grant `moderate`, admin) posts, still only as a participant. Posting also requires being able to read the session, so a participant who lost read access cannot post. Bots follow the same rules.

## Roles

| Role | Can |
|---|---|
| Sender | edit and delete their own messages (editing within the kind's `editWindowSeconds`) |
| Moderator, or a grant with `access: moderate` | delete any message, remove members and participants, approve join requests, change overridable settings (`canModerateSpace`); archive the space's sessions, remove their participants and delete their messages even in an `access: members` session they cannot read |
| Owner | all of the above, archive the space, transfer ownership, promote moderators (`canManageSpace`) |
| `homileo.chat.admin` | moderate and archive any space or session; read anything except space-less sessions; remove (not add) participants of space-less sessions |

Participants are added with `canAddParticipant` and removed with `canRemoveParticipant`.

- A `direct` session (a DM) has exactly its two participants and never an `owner`: nobody adds to
  it, not even an admin. One of the two whom an admin removed rejoins by asking for the DM again
  (`POST /sessions/direct`), unless it is archived.
- In a space-less group the participant `owner` adds and removes participants and renames it.
  `homileo.chat.admin` may remove participants but not add them, and cannot read the session or
  delete its messages: admins archive DMs and remove people, not touch their content. An admin who
  could add would add themselves and then read it.
- **Managing without reading.** Archiving a session and removing its participants load it without
  the read check for `managesWithoutReading`: an admin of its organization, or whoever moderates its
  space (`readableSession(…, { manage: true })`). Deleting a message loads it for
  `moderatesWithoutReading` only, a moderator of the session's space (`readableMessage(…,
  { moderate: true })`), since a space-less session's content has no moderator. So a space owner or
  moderator who is not a participant manages an `access: members` session without reading it. The
  action's own rule still decides, and every other route still answers `404`. The answer carries no
  content to a caller who cannot read the session: archive and message delete answer `204` with no
  body (a reader gets `200` and the view), and participant removal always answers `204`.
- In a space's session, whoever can moderate the space adds and removes participants, grant
  `moderate` holders included (moderators remove members).

## Decisions the module fixes

The design does not state these.

- **Archived is read-only.** An archived space or session (or a session in an archived space) refuses
  join, post, edit, delete, member and participant changes, space `PATCH` and join-request
  decisions with `409 resource_archived`, checked before the policy. Leaving (a space or a session) is the exception. Reading stays allowed.
  Moderation and management of the space itself (`canModerateSpace`, `canManageSpace`) are not
  blocked by archiving.
- **A deleted message cannot be edited, and cannot be deleted again.**
- **`homileo.chat.admin` passes every moderate and manage check** in the organization, except
  that it never reads a space-less session, deletes messages in one or adds participants to one,
  and posting still requires being a participant. In a space's sessions its moderator delete works without participating.
- **Grants:** `read` gives read only; `moderate` gives read and moderate. Neither makes the holder a
  member, a participant or a poster.
- **Editing and deleting one's own message requires being a current participant** (and able to read
  the session). A sender removed from an `access: space` session still reads their messages but
  cannot edit or delete them. A moderator's delete is unchanged. `editWindowOpen` answers the window
  alone, so a route can tell `403 edit_window_closed` from other refusals.
- **Moderator delete is by space.** A space-less session has no moderators: only the sender deletes.
  In a space, `canDeleteMessage` lets the space's moderator delete without reading the session;
  the sender's own delete still needs read.
- A kind's `editWindowSeconds` of `null` means no limit; a space-less session has none.

## Session and member actions

- **Archive a session** (`canArchiveSession`): in a space, `canModerateSpace`; in a space-less group,
  its participant `owner` or `homileo.chat.admin`; a DM, only `homileo.chat.admin`. The admin need
  not be a participant. A caller who can read the session gets `200` with its view; an admin or
  space moderator who archives one it cannot read (a DM, a space-less group, an `access: members`
  session) gets `204` and no body, as removing a participant answers `204`.
- **`409 external_ref_taken` is a known oracle.** Creating or editing a space with an `externalRef`
  that another space of the kind in the organization already has answers `409 external_ref_taken`,
  even when the caller cannot read that space. It is accepted: the uniqueness is the point of the
  reference, the answer reveals only that some space of the kind carries it (not its id or
  content), and only to a caller of the same organization who may create or edit spaces of that
  kind.
- **Create a session in a space** (`canCreateSessionIn`): space membership or `canModerateSpace`, an
  unarchived space, and `canModerateSpace` when `postPolicy` is `moderators`. `createSessionRefusal`
  names why it is false, in order: `not_found`, `archived` (`409 resource_archived`),
  `posting_restricted` (`403`), `not_a_member` (`403 forbidden`). Space-less groups and
  DMs are open to any caller (no function; routes need no check).
- **Member changes** (`canChangeMember`, in `members.ts`): `canModerateSpace` adds a `member` and
  removes a `member`. Adding a moderator or owner, any role change, and removing a moderator or
  owner need `canManageSpace`. A member may always leave, even an archived space. Every other change
  in an archived space is refused. The last-owner rule (`409 last_owner`) is a database check, not
  part of the policy: the route locks the space row, then its owner rows, and refuses a change that
  would leave none.
- **Losing access by removal**: removing a member also ends their participation in the space's
  sessions (`session.participant_removed`). A removed principal who can no longer read the space
  gets `space.access_revoked`, and `session.access_revoked` for each session they were in and can no
  longer read. When someone else is removed, this is judged from membership and visibility alone
  (a `members` space is lost, a `public` one kept; `access: members` sessions are lost); their kind
  grants and admin role are unknown to the caller and ignored. A leaving caller is judged with their
  own permissions.
- **Leave a session** (`canLeaveSession`): any participant except in a DM, archived or not.
  When the last `owner` of a space-less group leaves or is removed, ownership passes to the
  remaining participant who joined first (no event records the role change).
- **Kind bots** (decision 4): a kind's `bots` become `member`s of every new space of the kind and
  participants of every new session in those spaces; unseen ones are created as bot principals. A
  bot missing from an existing space is added as a member when a session is created there, so it can
  read an `access: space` session of a members-only space.
- **Metadata** is a flat object of the caller's choosing, scoped by the kind's app, and a `PATCH`
  replaces it whole (it is not merged). Changing a space's or session's `metadata`, `externalRef` or
  `state` needs `canModerateSpace`, or the participant `owner` in a space-less group. A space-less
  group has no kind, so its `state` is `400 invalid_state`.
- **Joining through an open space** also makes a non-member a space `member`
  (`space.member_added`). Adding someone else to a space's session needs them to be a space member.
- **`session.access_revoked`** follows a removal. When someone else is removed, only membership and
  visibility are judged (the removed principal's kind grants are unknown): a members-only or
  space-less session is revoked; a space session only for a non-member of a non-public space. When
  one leaves, their own facts decide. Both removal routes ask `canReadSession` with the facts
  after the change and a stand-in caller, `judgedAs` in `utils/access.ts` (the caller themselves
  when they leave; otherwise the principal with no permissions and no admin role).
- **React** (`canReact`): participation and an unarchived session and space; the post policy does
  not apply. `reactRefusal` names why it is false, as `postRefusal` does for posting:
  `not_found`, `archived`, `not_a_participant`.
- **Session settings** (`canEditSessionSettings`: rename, `metadata`, `externalRef`, `state`): in a
  space, `canModerateSpace` while neither the session nor the space is archived; in a space-less
  group, its `owner`; never a DM. An admin does not touch space-less content.
- **`postRefusal`** names why `canPost` is false, in order: `not_found` (cannot read), `archived`,
  `not_a_participant`, `posting_restricted`; `null` exactly when `canPost` is true.

## Messages

- **Post** (`postRefusal`): `404` when the caller cannot read the session, `409 resource_archived`,
  `403 not_a_participant`, `403 posting_restricted`, in that order. A repeat of a
  `clientMessageId` by a reader is answered (`409 duplicate_client_message`) before the other
  three, since it changes nothing. Bots post through the same route with their own token.
- **List**: anyone who can read the session, participant or not.
- **Revisions** (`canReadRevisions`): the sender, or whoever moderates the message's space, among
  those who can read the session; a space-less session's only to its sender. A deleted message's
  revisions too.
- **Read position on send:** a top-level message moves the sender's `last_read_seq` to its `seq`,
  and a reply moves the sender's thread `last_read_seq`. Your own messages are never unread.
- **Mentions:** a `<@id>` is stored in `message_mentions` only when `canReadSession` would let that
  principal read the session with no permissions (`isMentionReader`, through `mentionReaders` in
  `utils/access.ts`): in a space-less session, a current participant; in an `access: space`
  session, a member of the space, or a participant when the space is `public`; in an
  `access: members` session, a participant who is a member of the space or whose space is
  `public`. A `public` space alone does not count for a non-participant: principals are not
  organization-scoped, so it would admit any id, even one from another organization. Permissions
  are not known to the sender's request, so a reader only through a kind grant or
  `homileo.chat.admin` is not mentioned, and a participant who lost read on a members-only space
  gets no mention email. Sockets and `/sync` judge stored mentions again with the same function and
  the principal's current participation, membership and the space's visibility
  (`currentMentionReaders`), and `/me/mentions` and `/me/unread` keep only sessions the caller can
  read now. A token that is not a UUID stays
  text, and only the first 100 distinct ids of a message count (later ones are still rendered by
  name in `body_text`). Each stored reader is emailed
  through `core.outbox.notify` (recipient `userId` = their tereo user id) unless their `notify` is
  `none` (a reader who is not a participant counts as `all`), they are the sender, or they are a
  bot. `<!here>` and `<!session>` are stored and send no email.


## Sockets and `/sync`

Socket subscriptions, the rooms a socket joins and `/sync` use the same policy functions. A
`subscribe` is refused with `not_found` as a REST read would be. Rooms are re-checked with the
socket's own token permissions when access may have been lost, and every 300 s as a backstop.
Removing a member or participant takes their sockets out of the resource's room even when they can
still read it (see [realtime.md](realtime.md)).

## Lock order

Every mutation takes locks in one order, so two mutations cannot wait on each other: the space row,
then the session row, then any other row (owner rows, participants, messages).
`readableSpace({ tx, lock: true })` comes before `readableSession({ tx, lock: true })` when a route
needs both. A route that changes a session's participants or settings, archives it, or edits,
deletes or reacts to a message starts from a session id and locks its space first
(`db.sessions.lockSpaceOf(tx, organizationId, sessionId)`): `FOR SHARE`, since it needs the space
to stay as it is, not to change it. Every locking `SELECT` names the caller's organization, so a
leaked id of another organization's row locks nothing before the `404`. Because the space is only
shared, a self-join that makes the caller a space member inserts the membership with
`ON CONFLICT DO NOTHING`: the caller's parallel join of another session of the space may have
inserted it first, and then this join records no `space.member_added`. Space changes (`PATCH`, archive, member changes, join) take the space
`FOR UPDATE`. Sending a message locks only the session row, and a session read only the caller's
participant row. A thread read and a thread follow take no session lock: each is one statement on
the caller's follower row (`INSERT … ON CONFLICT`), as are a reply's follower writes, so they wait
only on each other. An attachment upload takes no lock. Removing a member locks the
space, then the owner rows, then the member's active sessions in id order, and only then changes
participants.
