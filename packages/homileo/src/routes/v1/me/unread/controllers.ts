import { validateQuery } from "../../../../utils/validateReq.js";
import { readableSessions } from "../../../../utils/access.js";
import { callerOf } from "../../../../middleware/auth.js";
import { prisma } from "../../../../utils/db/prisma.js";
import type { Request, Response } from "express";
import { UnreadQuerySchema } from "./schemas.js";

/** Counts stop here: the response says `unreadCapped` past `UNREAD_CAP`. */
const UNREAD_CAP = 99;
const COUNT_LIMIT = UNREAD_CAP + 1;

interface SessionRow {
  session_id: string;
  unread: number;
  mentions: number;
  last_seq: bigint;
  last_read_seq: bigint;
}

interface ThreadRow {
  root_id: string;
  session_id: string;
  unread: number;
}

export const getUnread = async (req: Request, res: Response) => {
  const caller = callerOf(req);
  validateQuery(UnreadQuerySchema, req);
  const me = caller.principalId;
  const org = caller.organizationId;

  // Each count reads at most COUNT_LIMIT rows, through the top-level and thread indexes.
  const sessionRows = await prisma.$queryRaw<SessionRow[]>`
    SELECT p.session_id::text AS session_id,
           u.n AS unread,
           m.n AS mentions,
           s.last_seq,
           p.last_read_seq
    FROM "chat"."session_participants" p
    JOIN "chat"."sessions" s ON s.id = p.session_id
    CROSS JOIN LATERAL (
      SELECT count(*)::int AS n FROM (
        SELECT 1 FROM "chat"."messages" x
        WHERE x.session_id = p.session_id
          AND x.thread_root_id IS NULL
          AND x.deleted_at IS NULL
          AND x.seq > p.last_read_seq
          AND x.sender_id <> ${me}::uuid
        LIMIT ${COUNT_LIMIT}
      ) t
    ) u
    CROSS JOIN LATERAL (
      SELECT count(*)::int AS n FROM (
        SELECT 1 FROM "chat"."messages" x
        WHERE x.session_id = p.session_id
          AND x.deleted_at IS NULL
          AND x.seq > p.last_read_seq
          AND x.sender_id <> ${me}::uuid
          AND EXISTS (
            SELECT 1 FROM "chat"."message_mentions" mm
            WHERE mm.message_id = x.id
              AND (mm.user_id = ${me}::uuid OR mm.kind IN ('here', 'session'))
          )
        LIMIT ${COUNT_LIMIT}
      ) t
    ) m
    WHERE p.user_id = ${me}::uuid
      AND p.left_at IS NULL
      AND s.organization_id = ${org}::uuid
      AND (u.n > 0 OR m.n > 0)`;

  const threadRows = await prisma.$queryRaw<ThreadRow[]>`
    SELECT tf.thread_root_id::text AS root_id,
           r.session_id::text AS session_id,
           u.n AS unread
    FROM "chat"."thread_followers" tf
    JOIN "chat"."messages" r ON r.id = tf.thread_root_id
    JOIN "chat"."sessions" s ON s.id = r.session_id
    JOIN "chat"."session_participants" p
      ON p.session_id = r.session_id AND p.user_id = ${me}::uuid AND p.left_at IS NULL
    CROSS JOIN LATERAL (
      SELECT count(*)::int AS n FROM (
        SELECT 1 FROM "chat"."messages" x
        WHERE x.thread_root_id = tf.thread_root_id
          AND x.deleted_at IS NULL
          AND x.seq > tf.last_read_seq
          AND x.sender_id <> ${me}::uuid
        LIMIT ${COUNT_LIMIT}
      ) t
    ) u
    WHERE tf.user_id = ${me}::uuid
      AND tf.following
      AND s.organization_id = ${org}::uuid
      AND u.n > 0
    ORDER BY tf.thread_root_id DESC`;

  const readable = await readableSessions(caller, [
    ...new Set([
      ...sessionRows.map((r) => r.session_id),
      ...threadRows.map((r) => r.session_id),
    ]),
  ]);

  res.status(200).json({
    sessions: sessionRows
      .filter((r) => readable.has(r.session_id))
      .map((r) => ({
        sessionId: r.session_id,
        unread: Math.min(r.unread, UNREAD_CAP),
        unreadCapped: r.unread > UNREAD_CAP,
        mentions: Math.min(r.mentions, UNREAD_CAP),
        lastSeq: Number(r.last_seq),
        lastReadSeq: Number(r.last_read_seq),
      })),
    threads: threadRows
      .filter((r) => readable.has(r.session_id))
      .map((r) => ({
        rootId: r.root_id,
        sessionId: r.session_id,
        unread: Math.min(r.unread, UNREAD_CAP),
        unreadCapped: r.unread > UNREAD_CAP,
      })),
  });
};
