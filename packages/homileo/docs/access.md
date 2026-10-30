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

## Read a space

Any of: the caller is a member; `visibility` is `public`; the space's kind grants a permission the
caller holds (grant `read` or `moderate`); the caller has `homileo.chat.admin`.

## Read a session

| Session | Readable by |
|---|---|
| In a space, `access: space` | anyone who can read the space |
| In a space, `access: members` | participants, holders of a kind grant, `homileo.chat.admin` |
| No space | participants only (`homileo.chat.admin` cannot read) |

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
| Moderator, or a grant with `access: moderate` | delete any message, remove members and participants, approve join requests, change overridable settings (`canModerateSpace`) |
| Owner | all of the above, archive the space, transfer ownership, promote moderators (`canManageSpace`) |
| `homileo.chat.admin` | moderate and archive any space or session; read anything except space-less sessions; remove (not add) participants of space-less sessions |

Participants are added with `canAddParticipant` and removed with `canRemoveParticipant`.

- A `direct` session (a DM) has exactly its two participants and never an `owner`: nobody adds to
  it, not even an admin.
- In a space-less group the participant `owner` adds and removes participants and renames it.
  `homileo.chat.admin` may remove participants but not add them, and cannot read the session or
  delete its messages: admins archive DMs and remove people, not touch their content. An admin who
  could add would add themselves and then read it. For archiving and removing, the routes load a
  space-less session for an admin of its organization without the read check
  (`readableSession(…, { adminManage: true })`); every other route still answers `404`.
- In a space's session, whoever can moderate the space adds and removes participants, grant
  `moderate` holders included (moderators remove members).

## Decisions the module fixes

The design does not state these.

- **Archived is read-only.** An archived space or session (or a session in an archived space) refuses
  join, post, edit, delete, member and participant changes with `409 resource_archived`, checked
  before the policy. Leaving (a space or a session) is the exception. Reading stays allowed.
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
- A kind's `editWindowSeconds` of `null` means no limit; a space-less session has none.

## Session and member actions

- **Archive a session** (`canArchiveSession`): in a space, `canModerateSpace`; in a space-less group,
  its participant `owner` or `homileo.chat.admin`; a DM, only `homileo.chat.admin`. The admin need
  not be a participant.
- **Create a session in a space** (`canCreateSessionIn`): space membership or `canModerateSpace`, an
  unarchived space, and `canModerateSpace` when `postPolicy` is `moderators`. Space-less groups and
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
  not apply.
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
- **Mentions:** a `<@id>` is stored in `message_mentions` only when that principal is a current
  participant of the session or, in an `access: space` session, a member of its space
  (`isMentionReader`, through `mentionReaders` in `utils/access.ts`). Visibility does not count:
  principals are not organization-scoped, so a `public` space would admit any id, even one from
  another organization. Permissions are not known to the sender's request, so a reader only
  through a kind grant or `homileo.chat.admin` is not mentioned. A token that is not a UUID stays
  text, and only the first 100 distinct ids of a message count (later ones are still rendered by
  name in `body_text`). Each stored reader is emailed
  through `core.outbox.notify` (recipient `userId` = their tereo user id) unless their `notify` is
  `none` (a reader who is not a participant counts as `all`), they are the sender, or they are a
  bot. `<!here>` and `<!session>` are stored and send no email.


## Lock order

Every mutation takes locks in one order, so two mutations cannot wait on each other: the space row,
then the session row, then any other row (owner rows, participants, messages).
`readableSpace({ tx, lock: true })` comes before `readableSession({ tx, lock: true })` when a route
needs both; a route that starts from a session id locks its space first
(`db.sessions.lockSpaceOf`). Removing a member locks the space, then the owner rows, then the
member's active sessions in id order, and only then changes participants.
