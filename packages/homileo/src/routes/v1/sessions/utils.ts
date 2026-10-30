import type { Session } from "../../../../prisma/generated/client/index.js";
import type { SessionPageStart } from "../../../utils/db/sessions.js";
import { decodeCursor, encodeCursor } from "../../../utils/cursor.js";
import { ValidationError } from "../../../utils/errors.js";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const validDate = (value: unknown): value is string =>
  typeof value === "string" &&
  ISO.test(value) &&
  new Date(value).toISOString() === value;

/**
 * The cursor holds `[lastMessageAt, createdAt, id]`. `decodeCursor` takes only strings and
 * numbers, so a session with no messages has `""` for `lastMessageAt`.
 */
export const encodeSessionCursor = (row: Session): string =>
  encodeCursor([
    row.lastMessageAt?.toISOString() ?? "",
    row.createdAt.toISOString(),
    row.id,
  ]);

export const parseSessionCursor = (cursor: string): SessionPageStart => {
  const [lastMessageAt, createdAt, id] = decodeCursor(cursor, 3);
  if (
    !(lastMessageAt === "" || validDate(lastMessageAt)) ||
    !validDate(createdAt) ||
    typeof id !== "string" ||
    !ID.test(id)
  ) {
    throw new ValidationError("Invalid cursor");
  }
  return {
    lastMessageAt: lastMessageAt === "" ? null : new Date(lastMessageAt),
    createdAt: new Date(createdAt),
    id,
  };
};
