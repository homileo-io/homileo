import type { MessageFacts, SessionFacts } from "./types.js";
import type { OrgCaller } from "../middleware/auth.js";
import { canReadSession } from "./sessions.js";
import { canModerateSpace } from "./spaces.js";

const isWritable = (ss: SessionFacts): boolean =>
  !ss.archived && !(ss.space?.archived ?? false);

const isOwnMessage = (c: OrgCaller, m: MessageFacts): boolean =>
  m.senderId === c.principalId;

export const canEditMessage = (
  c: OrgCaller,
  ss: SessionFacts,
  m: MessageFacts,
  now: Date
): boolean => {
  if (!isWritable(ss) || m.deleted || !isOwnMessage(c, m)) return false;
  if (!canReadSession(c, ss)) return false;
  const windowSeconds = ss.space?.kind.editWindowSeconds ?? null;
  if (windowSeconds === null) return true;
  return now.getTime() - m.createdAt.getTime() <= windowSeconds * 1000;
};

export const canDeleteMessage = (
  c: OrgCaller,
  ss: SessionFacts,
  m: MessageFacts
): boolean => {
  if (!isWritable(ss) || m.deleted) return false;
  if (!canReadSession(c, ss)) return false;
  if (isOwnMessage(c, m)) return true;
  return ss.space !== null && canModerateSpace(c, ss.space);
};
