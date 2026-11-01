import { decodeCursor, encodeCursor } from "../../../../utils/cursor.js";
import { validateQuery } from "../../../../utils/validateReq.js";
import { readableSessions } from "../../../../utils/access.js";
import { ValidationError } from "../../../../utils/errors.js";
import { sessionView } from "../../../../views/session.js";
import { callerOf } from "../../../../middleware/auth.js";
import { IdSchema } from "../../../../utils/idSchema.js";
import { prisma } from "../../../../utils/db/prisma.js";
import { ListMentionsQuerySchema } from "./schemas.js";
import { db } from "../../../../utils/db/index.js";
import type { Request, Response } from "express";

const parseCursor = (cursor: string): string => {
  const [id] = decodeCursor(cursor, 1);
  const parsed = IdSchema.safeParse(id);
  if (!parsed.success || parsed.data !== id) {
    throw new ValidationError("Invalid cursor");
  }
  return parsed.data;
};

export const listMentions = async (req: Request, res: Response) => {
  const caller = callerOf(req);
  const { cursor, limit } = validateQuery(ListMentionsQuerySchema, req);
  const before = cursor ? parseCursor(cursor) : null;
  const me = caller.principalId;

  // The session is re-checked below, so user mentions need no participation;
  // here/session mentions come only from sessions the caller currently is in.
  const found = await db.mentions.listIds(prisma, {
    organizationId: caller.organizationId,
    userId: me,
    before,
    limit: limit + 1,
  });

  const pageIds = found.slice(0, limit);
  const rows = await prisma.message.findMany({
    where: { id: { in: pageIds } },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const readable = await readableSessions(caller, [
    ...new Set(rows.map((r) => r.sessionId)),
  ]);
  const kept = pageIds
    .map((id) => byId.get(id))
    .filter(
      (r): r is NonNullable<typeof r> => !!r && readable.has(r.sessionId)
    );
  const views = await db.messages.loadViews(prisma, kept);

  res.status(200).json({
    data: kept.map((row, i) => ({
      message: views[i],
      session: sessionView(readable.get(row.sessionId)!),
    })),
    nextCursor:
      found.length > limit ? encodeCursor([pageIds[pageIds.length - 1]]) : null,
  });
};
