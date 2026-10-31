import type { Session } from "../../../../prisma/generated/client/index.js";
import type { SessionPageStart } from "../../../utils/db/sessions.js";
import { encodeCursor, parseCursor } from "../../../utils/cursor.js";
import { SessionCursorSchema } from "./schemas.js";

export const encodeSessionCursor = (row: Session): string =>
  encodeCursor([
    row.lastMessageAt?.toISOString() ?? "",
    row.createdAt.toISOString(),
    row.id,
  ]);

export const parseSessionCursor = (cursor: string): SessionPageStart => {
  const [lastMessageAt, createdAt, id] = parseCursor(
    cursor,
    SessionCursorSchema
  );
  return {
    lastMessageAt: lastMessageAt === "" ? null : new Date(lastMessageAt),
    createdAt: new Date(createdAt),
    id,
  };
};
