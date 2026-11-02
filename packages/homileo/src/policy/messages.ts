import type { MessageFacts, SessionFacts, SpaceFacts } from "./types.js";
import { canReadSession, moderatesWithoutReading } from "./sessions.js";
import type { OrgCaller } from "../middleware/auth.js";
import { canModerateSpace } from "./spaces.js";

const isWritable = (ss: SessionFacts): boolean =>
  !ss.archived && !(ss.space?.archived ?? false);

const isOwnMessage = (c: OrgCaller, m: MessageFacts): boolean =>
  m.senderId === c.principalId;

/** Own edit or delete needs current participation, even where the session is still readable. */
const isCurrentSender = (
  c: OrgCaller,
  ss: SessionFacts,
  m: MessageFacts
): boolean => isOwnMessage(c, m) && ss.participantRole !== null;

/** Whether the kind's edit window still covers the message; separates `edit_window_closed` from other refusals. */
export const editWindowOpen = (
  ss: SessionFacts,
  m: MessageFacts,
  now: Date
): boolean => {
  const windowSeconds = ss.space?.kind.editWindowSeconds ?? null;
  if (windowSeconds === null) return true;
  return now.getTime() - m.createdAt.getTime() <= windowSeconds * 1000;
};

export const canEditMessage = (
  c: OrgCaller,
  ss: SessionFacts,
  m: MessageFacts,
  now: Date
): boolean => {
  if (!isWritable(ss) || m.deleted || !isCurrentSender(c, ss, m)) return false;
  if (!canReadSession(c, ss)) return false;
  return editWindowOpen(ss, m, now);
};

/** A space's moderator deletes in its sessions without reading them; `access: members` ones included. */
export const canDeleteMessage = (
  c: OrgCaller,
  ss: SessionFacts,
  m: MessageFacts
): boolean => {
  if (!isWritable(ss) || m.deleted) return false;
  if (moderatesWithoutReading(c, ss)) return true;
  return canReadSession(c, ss) && isCurrentSender(c, ss, m);
};

/**
 * A message's revisions: its sender, and whoever moderates its space. A deleted message's earlier
 * text stays out of everyone else's reach, a space-less session's too.
 */
export const canReadRevisions = (
  c: OrgCaller,
  ss: SessionFacts,
  m: MessageFacts
): boolean => {
  if (!canReadSession(c, ss)) return false;
  if (isOwnMessage(c, m)) return true;
  return ss.space !== null && canModerateSpace(c, ss.space);
};

/**
 * Whether a mentioned principal is stored, emailed and reached as mentioned: what `canReadSession`
 * says of them with no permissions. Their kind grants and admin role are not known to the sender's
 * request, so they count for nothing. A public space alone does not count for a non-participant:
 * principals are not organization-scoped, so it would admit any id.
 */
export const isMentionReader = (
  ss: Pick<SessionFacts, "access"> & {
    space: Pick<SpaceFacts, "visibility"> | null;
  },
  p: { participantRole: string | null; spaceRole: string | null }
): boolean => {
  const participates = p.participantRole !== null;
  if (ss.space === null) return participates;
  if (p.spaceRole !== null) return ss.access === "space" || participates;
  return participates && ss.space.visibility === "public";
};
