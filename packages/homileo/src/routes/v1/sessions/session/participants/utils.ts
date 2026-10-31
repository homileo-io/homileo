import type { ParticipantPageStart } from "../../../../../utils/db/participants.js";
import { encodeCursor, parseCursor } from "../../../../../utils/cursor.js";
import { ParticipantCursorSchema } from "./schemas.js";

export const encodeParticipantCursor = (row: {
  joinedAt: Date;
  userId: string;
}): string => encodeCursor([row.joinedAt.toISOString(), row.userId]);

export const parseParticipantCursor = (
  cursor: string
): ParticipantPageStart => {
  const [joinedAt, principalId] = parseCursor(cursor, ParticipantCursorSchema);
  return { joinedAt: new Date(joinedAt), principalId };
};
