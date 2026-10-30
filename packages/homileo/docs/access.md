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
  could add would add themselves and then read it.
- In a space's session, whoever can moderate the space adds and removes participants, grant
  `moderate` holders included (moderators remove members).

## Decisions the module fixes

The design does not state these.

- **Archived is read-only.** An archived space or session (or a session in an archived space) refuses
  join, post, edit, delete and participant changes. Reading stays allowed. Moderation and
  management of the space itself (`canModerateSpace`, `canManageSpace`) are not blocked by archiving.
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
  its participant `owner` or `homileo.chat.admin`; a DM, only `homileo.chat.admin`.
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
- **Leave a session** (`canLeaveSession`): any participant of an unarchived session except a DM.
- **React** (`canReact`): participation and an unarchived session and space; the post policy does
  not apply.
- **Session settings** (`canEditSessionSettings`: rename, `metadata`, `externalRef`, `state`): in a
  space, `canModerateSpace` while neither the session nor the space is archived; in a space-less
  group, its `owner`; never a DM. An admin does not touch space-less content.
- **`postRefusal`** names why `canPost` is false, in order: `not_found` (cannot read), `archived`,
  `not_a_participant`, `posting_restricted`; `null` exactly when `canPost` is true.
