import type { ParticipantPageStart } from "../../../../../utils/db/participants.js";
import { decodeCursor, encodeCursor } from "../../../../../utils/cursor.js";
import { ValidationError } from "../../../../../utils/errors.js";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The cursor holds `[joinedAt, principalId]`. */
export const encodeParticipantCursor = (row: {
  joinedAt: Date;
  userId: string;
}): string => encodeCursor([row.joinedAt.toISOString(), row.userId]);

export const parseParticipantCursor = (
  cursor: string
): ParticipantPageStart => {
  const [joinedAt, principalId] = decodeCursor(cursor, 2);
  if (
    typeof joinedAt !== "string" ||
    !ISO.test(joinedAt) ||
    new Date(joinedAt).toISOString() !== joinedAt ||
    typeof principalId !== "string" ||
    !ID.test(principalId)
  ) {
    throw new ValidationError("Invalid cursor");
  }
  return {
    joinedAt: new Date(joinedAt),
    principalId: principalId.toLowerCase(),
  };
};
