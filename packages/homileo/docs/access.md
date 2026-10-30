# Access

Every access check goes through one module of pure functions, `src/policy/` (`canReadSpace`,
`canReadSession`, `canPost`, …). REST routes, socket subscriptions and `/sync` call it with facts the
caller loaded (`SpaceFacts`, `SessionFacts`, `MessageFacts`) and the `OrgCaller`; it does no I/O.
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
- **Editing and deleting one's own message requires still being able to read the session**, so a
  removed participant cannot touch old messages.
- **Moderator delete is by space.** A space-less session has no moderators: only the sender deletes.
- A kind's `editWindowSeconds` of `null` means no limit; a space-less session has none.
