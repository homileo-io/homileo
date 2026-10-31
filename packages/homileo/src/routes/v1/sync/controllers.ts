import { readableSessions, readableSpaces } from "../../../utils/access.js";
import { Prisma } from "../../../../prisma/generated/client/index.js";
import { ResyncRequiredError } from "../../../utils/errors.js";
import { validateQuery } from "../../../utils/validateReq.js";
import { EVENT_TYPES, type EventType } from "@homileo-io/sdk";
import { callerOf } from "../../../middleware/auth.js";
import { prisma } from "../../../utils/db/prisma.js";
import { eventView } from "../../../views/event.js";
import type { Request, Response } from "express";
import { db } from "../../../utils/db/index.js";
import { SyncQuerySchema } from "./schemas.js";
import {
  decodeSyncCursor,
  encodeSyncCursor,
} from "../../../realtime/syncCursor.js";
import {
  isRelevantTo,
  mentionedMessageOf,
  MENTION_EVENTS,
  SPACE_SESSION_EVENTS,
  TARGET_PATHS,
  type ReaderFacts,
} from "../../../realtime/audience.js";

/** No transaction outlives this past the oldest retained day (Decision 3). */
const RESYNC_MARGIN_MS = 10 * 60 * 1000;

const typesOf = (channel: "space" | "session"): EventType[] =>
  (Object.keys(EVENT_TYPES) as EventType[]).filter(
    (t) => EVENT_TYPES[t].channel === channel
  );
const SESSION_TYPES = typesOf("session");
const SPACE_TYPES = [...typesOf("space"), ...SPACE_SESSION_EVENTS];

const unique = (ids: Iterable<string>) => [...new Set(ids)];

/**
 * Narrows the log to what may concern the reader; `isRelevantTo` then
 * decides. Never narrower than it: an event it would keep must match here.
 */
const prefilter = (
  organizationId: string,
  principalId: string,
  sessionIds: string[],
  spaceIds: string[]
): Prisma.Sql => {
  const targeted = Object.entries(TARGET_PATHS).map(
    ([type, path]) =>
      Prisma.sql`(type = ${type} AND payload #>> ${path}::text[] = ${principalId})`
  );
  const events = Prisma.raw(db.events.EVENTS_ALIAS);
  return Prisma.sql`organization_id = ${organizationId}::uuid AND (
    (session_id = ANY(${sessionIds}::uuid[]) AND type = ANY(${SESSION_TYPES}::text[]))
    OR (space_id = ANY(${spaceIds}::uuid[]) AND type = ANY(${SPACE_TYPES}::text[]))
    OR ${Prisma.join(targeted, " OR ")}
    OR (type = ANY(${MENTION_EVENTS}::text[]) AND EXISTS (
      SELECT 1 FROM "chat"."message_mentions" m
      WHERE m.user_id = ${principalId}::uuid
        AND m.message_id::text = ${events}.payload #>> '{message,id}'))
  )`;
};

export const sync = async (req: Request, res: Response) => {
  const caller = callerOf(req);
  const query = validateQuery(SyncQuerySchema, req);
  if (!query.since) {
    res.status(200).json({
      events: [],
      next: encodeSyncCursor(await db.events.head()),
      hasMore: false,
    });
    return;
  }
  const after = decodeSyncCursor(query.since);
  const oldest = await db.events.oldestRetainedDay();
  if (oldest && after.at.getTime() < oldest.getTime() + RESYNC_MARGIN_MS) {
    throw new ResyncRequiredError();
  }

  const me = caller.principalId;
  const [memberships, participations] = await Promise.all([
    prisma.spaceMember.findMany({
      where: { userId: me, space: { organizationId: caller.organizationId } },
      select: { spaceId: true },
    }),
    prisma.sessionParticipant.findMany({
      where: {
        userId: me,
        leftAt: null,
        session: { organizationId: caller.organizationId },
      },
      select: { sessionId: true },
    }),
  ]);
  const memberOf = new Set(memberships.map((m) => m.spaceId));
  const participantOf = new Set(participations.map((p) => p.sessionId));

  const { rows, next, hasMore } = await db.events.readFrom(
    after,
    prefilter(
      caller.organizationId,
      me,
      unique([...participantOf, ...query.sessionIds]),
      unique([...memberOf, ...query.spaceIds])
    ),
    query.limit
  );

  const messageIds = unique(rows.flatMap((r) => mentionedMessageOf(r) ?? []));
  const [sessions, spaces, mentions] = await Promise.all([
    readableSessions(
      caller,
      unique(rows.flatMap((r) => (r.sessionId ? [r.sessionId] : [])))
    ),
    readableSpaces(
      caller,
      unique(rows.flatMap((r) => (r.spaceId ? [r.spaceId] : [])))
    ),
    messageIds.length === 0
      ? []
      : prisma.messageMention.findMany({
          where: { userId: me, messageId: { in: messageIds } },
          select: { messageId: true },
        }),
  ]);
  const reader: ReaderFacts = {
    principalId: me,
    organizationId: caller.organizationId,
    participantOf,
    memberOf,
    watchedSessions: new Set(query.sessionIds),
    watchedSpaces: new Set(query.spaceIds),
    mentionedIn: new Set(mentions.map((m) => m.messageId)),
    canReadSession: (id) => sessions.has(id),
    canReadSpace: (id) => spaces.has(id),
  };

  res.status(200).json({
    events: rows.filter((r) => isRelevantTo(r, reader)).map(eventView),
    next: encodeSyncCursor(next),
    hasMore,
  });
};
