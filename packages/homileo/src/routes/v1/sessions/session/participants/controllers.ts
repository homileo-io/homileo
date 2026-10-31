import { participantView, principalView } from "../../../../../views/index.js";
import { encodeParticipantCursor, parseParticipantCursor } from "./utils.js";
import { readableSession } from "../../../../../utils/access.js";
import { db, prisma } from "../../../../../utils/db/index.js";
import { callerOf } from "../../../../../middleware/auth.js";
import { ListParticipantsQuerySchema } from "./schemas.js";
import { SessionParamsSchema } from "../schemas.js";
import type { Request, Response } from "express";
import {
  validateParams,
  validateQuery,
} from "../../../../../utils/validateReq.js";

export const listParticipants = async (req: Request, res: Response) => {
  const caller = callerOf(req);
  const { sessionId } = validateParams(SessionParamsSchema, req);
  const query = validateQuery(ListParticipantsQuerySchema, req);
  const after = query.cursor ? parseParticipantCursor(query.cursor) : undefined;
  await readableSession(caller, sessionId);

  const rows = await db.participants.listCurrent(
    prisma,
    sessionId,
    after,
    query.limit + 1
  );
  const page = rows.slice(0, query.limit);
  res.status(200).json({
    data: page.map((row) => ({
      ...participantView(row),
      principal: principalView(row.user),
    })),
    nextCursor:
      rows.length > query.limit
        ? encodeParticipantCursor(page[page.length - 1])
        : null,
  });
};
