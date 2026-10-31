import type { MessageFacts, SessionFacts } from "./types.js";
import type { OrgCaller } from "../middleware/auth.js";
import { canReadSession } from "./sessions.js";
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

export const canDeleteMessage = (
  c: OrgCaller,
  ss: SessionFacts,
  m: MessageFacts
): boolean => {
  if (!isWritable(ss) || m.deleted) return false;
  if (!canReadSession(c, ss)) return false;
  if (isCurrentSender(c, ss, m)) return true;
  return ss.space !== null && canModerateSpace(c, ss.space);
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
 * Whether a mentioned principal is stored as mentioned: a current participant, or, in an
 * `access: space` session, a member of its space. Visibility and permissions do not count:
 * principals are not organization-scoped, so a public space would admit any id.
 */
export const isMentionReader = (
  ss: SessionFacts,
  p: { participantRole: string | null; spaceRole: string | null }
): boolean =>
  p.participantRole !== null ||
  (ss.space !== null && ss.access === "space" && p.spaceRole !== null);
