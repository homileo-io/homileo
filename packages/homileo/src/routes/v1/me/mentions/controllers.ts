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

  // User mentions need no participation (the session is re-checked below);
  // here/session mentions count only where the caller currently participates.
  const found = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT m.id::text AS id
    FROM "chat"."messages" m
    JOIN "chat"."sessions" s ON s.id = m.session_id
    WHERE s.organization_id = ${caller.organizationId}::uuid
      AND m.deleted_at IS NULL
      AND m.sender_id <> ${me}::uuid
      AND (${before}::uuid IS NULL OR m.id < ${before}::uuid)
      AND EXISTS (
        SELECT 1 FROM "chat"."message_mentions" mm
        WHERE mm.message_id = m.id
          AND (
            mm.user_id = ${me}::uuid
            OR (
              mm.kind IN ('here', 'session')
              AND EXISTS (
                SELECT 1 FROM "chat"."session_participants" p
                WHERE p.session_id = m.session_id
                  AND p.user_id = ${me}::uuid
                  AND p.left_at IS NULL
              )
            )
          )
      )
    ORDER BY m.id DESC
    LIMIT ${limit + 1}`;

  const pageIds = found.slice(0, limit).map((r) => r.id);
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
