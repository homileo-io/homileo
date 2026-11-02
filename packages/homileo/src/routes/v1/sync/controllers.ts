import { ResyncRequiredError, ValidationError } from "../../../utils/errors.js";
import { EVENT_TYPES, MessageSchema, type EventType } from "@homileo-io/sdk";
import { Prisma } from "../../../../prisma/generated/client/index.js";
import { validateQuery } from "../../../utils/validateReq.js";
import type { EventRow } from "../../../utils/db/events.js";
import { callerOf } from "../../../middleware/auth.js";
import { IdSchema } from "../../../utils/idSchema.js";
import { prisma } from "../../../utils/db/prisma.js";
import { eventView } from "../../../views/event.js";
import type { Request, Response } from "express";
import { db } from "../../../utils/db/index.js";
import { SyncQuerySchema } from "./schemas.js";
import env from "../../../env.js";
import {
  decodeSyncCursor,
  encodeSyncCursor,
  tooOldToSync,
} from "../../../realtime/syncCursor.js";
import {
  isRelevantTo,
  mentionedMessageOf,
  MENTION_EVENTS,
  MODERATOR_EVENTS,
  SPACE_SESSION_EVENTS,
  TARGET_PATHS,
  type ReaderFacts,
} from "../../../realtime/audience.js";
import {
  currentMentionReaders,
  moderatedSpaces,
  readableSessions,
  readableSpaces,
} from "../../../utils/access.js";

const typesOf = (channel: "space" | "session"): EventType[] =>
  (Object.keys(EVENT_TYPES) as EventType[]).filter(
    (t) => EVENT_TYPES[t].channel === channel
  );
const SESSION_TYPES = typesOf("session");
const SPACE_TYPES = [...typesOf("space"), ...SPACE_SESSION_EVENTS];

const unique = (ids: Iterable<string>) => [...new Set(ids)];

/** Events whose payload carries a message view under `message`. */
const MESSAGE_EVENTS = (Object.keys(EVENT_TYPES) as EventType[]).filter(
  (t) =>
    (EVENT_TYPES[t].payload as { shape?: Record<string, unknown> }).shape
      ?.message === MessageSchema
);

// Only an id the log could hold: a stray value must not fail a uuid cast.
const messageIdOf = (e: EventRow): string | null => {
  if (!MESSAGE_EVENTS.includes(e.type)) return null;
  const id = (e.payload as { message?: { id?: unknown } } | null)?.message?.id;
  return IdSchema.safeParse(id).success ? (id as string) : null;
};

/**
 * Replaces each message event's stored view with the message's view now, as
 * REST builds it, so the log never replays text a delete or edit replaced.
 * The stored reaction summaries stay: the page's later `reaction.*` events are
 * deltas from them. An event whose message row is gone is dropped.
 */
const withCurrentMessages = async (rows: EventRow[]): Promise<EventRow[]> => {
  const ids = unique(rows.flatMap((r) => messageIdOf(r) ?? []));
  if (ids.length === 0) return rows;
  const current = await prisma.message.findMany({ where: { id: { in: ids } } });
  const views = new Map(
    (await db.messages.loadViews(prisma, current)).map((v) => [v.id, v])
  );
  return rows.flatMap((r) => {
    if (!MESSAGE_EVENTS.includes(r.type)) return [r];
    const id = messageIdOf(r);
    const view = id ? views.get(id) : undefined;
    if (!view) return [];
    const stored = (r.payload as { message?: { reactions?: unknown } }).message
      ?.reactions;
    const message = {
      ...view,
      reactions: Array.isArray(stored) ? stored : view.reactions,
    };
    return [{ ...r, payload: { ...(r.payload as object), message } }];
  });
};

const UUID_PATTERN =
  "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

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
        AND m.message_id = CASE
          WHEN ${events}.payload #>> '{message,id}' ~* ${UUID_PATTERN}
          THEN (${events}.payload #>> '{message,id}')::uuid
        END))
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
  if (tooOldToSync(after.at, oldest, new Date(), env.EVENT_RETENTION_DAYS)) {
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

  const page = await db.events.readFrom(
    after,
    prefilter(
      caller.organizationId,
      me,
      unique([...participantOf, ...query.sessionIds]),
      unique([...memberOf, ...query.spaceIds])
    ),
    query.limit,
    // The organization leads the index readFrom scans in, and the prefilter requires it.
    { scope: Prisma.sql`organization_id = ${caller.organizationId}::uuid` }
  );
  const { rows } = page;
  const { until } = query;
  // No position this database issued lies past the first unassigned transaction id.
  for (const [path, cursor] of [
    ["since", after],
    ["until", until],
  ] as const) {
    if (cursor && cursor.txId > page.tail) {
      throw new ValidationError("Invalid cursor", [
        { path, message: "Not issued by this database" },
      ]);
    }
  }
  // Every transaction below the horizon has ended, so the read passed `until`
  // once the horizon is at or above it.
  const waiting = until !== undefined && page.horizon < until.txId;
  const hasMore = page.hasMore || waiting;
  // While more remains, the cursor keeps the time it was issued (as readFrom does).
  const next = waiting ? { ...page.next, at: after.at } : page.next;

  const messageIds = unique(
    rows.flatMap((r) => mentionedMessageOf(r) ?? [])
  ).filter((id) => IdSchema.safeParse(id).success);
  const [sessions, spaces, moderated, mentions] = await Promise.all([
    readableSessions(
      caller,
      unique(rows.flatMap((r) => (r.sessionId ? [r.sessionId] : [])))
    ),
    readableSpaces(
      caller,
      unique(rows.flatMap((r) => (r.spaceId ? [r.spaceId] : [])))
    ),
    moderatedSpaces(
      caller,
      unique(
        rows.flatMap((r) =>
          r.spaceId && MODERATOR_EVENTS.includes(r.type) ? [r.spaceId] : []
        )
      )
    ),
    db.messages.storedMentionsOf(prisma, messageIds, me),
  ]);
  const reader: ReaderFacts = {
    principalId: me,
    organizationId: caller.organizationId,
    participantOf,
    memberOf,
    watchedSessions: new Set(query.sessionIds),
    watchedSpaces: new Set(query.spaceIds),
    mentionedIn: new Set(currentMentionReaders(mentions).keys()),
    canReadSession: (id) => sessions.has(id),
    canReadSpace: (id) => spaces.has(id),
    canModerateSpace: (id) => moderated.has(id),
  };

  const relevant = await withCurrentMessages(
    rows.filter((r) => isRelevantTo(r, reader))
  );
  res.status(200).json({
    events: relevant.map(eventView),
    next: encodeSyncCursor(next),
    hasMore,
  });
};
