import { Prisma as PrismaValues } from "../../../prisma/generated/client/index.js";
import type { ReactionSummary, Message as MessageView } from "@homileo-io/sdk";
import type { ParsedMentions } from "../mentions.js";
import { messageView } from "../../views/message.js";
import { prisma, type Prisma } from "./prisma.js";
import type {
  Message,
  NotifyLevel,
  ParticipantRole,
  SpaceRole,
} from "../../../prisma/generated/client/index.js";

type Tx = Prisma.TransactionClient;
type Client = Tx | typeof prisma;

export type { Message };

/** How many reactors a reaction summary names. */
const REACTION_PRINCIPALS = 50;

/** Reaction summaries by message id: per emoji the count and the first reactors; a message with none is absent. */
export const reactionSummaries = async (
  client: Client,
  messageIds: string[]
): Promise<Map<string, ReactionSummary[]>> => {
  const rows = await client.$queryRaw<
    Array<{
      message_id: string;
      emoji: string;
      count: number;
      principal_ids: string[];
    }>
  >`
    SELECT message_id::text, emoji, count(*)::int AS count,
      (array_agg(user_id::text ORDER BY created_at, user_id))[1:${REACTION_PRINCIPALS}] AS principal_ids
    FROM "chat"."reactions"
    WHERE message_id = ANY(${messageIds}::uuid[])
    GROUP BY message_id, emoji
    ORDER BY message_id, min(created_at), emoji`;
  const byMessage = new Map<string, ReactionSummary[]>();
  for (const r of rows) {
    const list = byMessage.get(r.message_id) ?? [];
    list.push({
      emoji: r.emoji,
      count: r.count,
      principalIds: r.principal_ids,
    });
    byMessage.set(r.message_id, list);
  }
  return byMessage;
};

/** Attachments (by position) and reaction summaries for a page of messages, then their views. */
export const loadViews = async (
  client: Client,
  rows: Message[]
): Promise<MessageView[]> => {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const attachments = await client.attachment.findMany({
    where: { messageId: { in: ids } },
    orderBy: [{ messageId: "asc" }, { position: "asc" }],
  });
  const reactionsOf = await reactionSummaries(client, ids);

  const attachmentsOf = new Map<string, typeof attachments>();
  for (const a of attachments) {
    attachmentsOf.set(a.messageId, [
      ...(attachmentsOf.get(a.messageId) ?? []),
      a,
    ]);
  }
  return rows.map((row) =>
    messageView({
      ...row,
      attachments: attachmentsOf.get(row.id) ?? [],
      reactions: reactionsOf.get(row.id) ?? [],
    })
  );
};

export const findByClientId = (
  tx: Tx,
  sessionId: string,
  senderId: string,
  clientMessageId: string
): Promise<Message | null> =>
  tx.message.findUnique({
    where: {
      sessionId_senderId_clientMessageId: {
        sessionId,
        senderId,
        clientMessageId,
      },
    },
  });

/** A message of the session, or `null`; a root from another session is `null` too. */
export const findInSession = (
  tx: Tx,
  sessionId: string,
  id: string
): Promise<Message | null> =>
  tx.message.findFirst({ where: { id, sessionId } });

/**
 * Takes the session's next `seq`. A top-level message also moves
 * `last_message_at`; a reply leaves it.
 */
export const nextSeq = async (
  tx: Tx,
  sessionId: string,
  at: Date,
  topLevel: boolean
): Promise<bigint> => {
  const rows = await tx.$queryRaw<Array<{ last_seq: bigint }>>`
    UPDATE "chat"."sessions"
    SET last_seq = last_seq + 1,
        last_message_at = CASE WHEN ${topLevel} THEN ${at} ELSE last_message_at END
    WHERE id = ${sessionId}::uuid
    RETURNING last_seq`;
  return rows[0].last_seq;
};

export interface InsertMessageInput {
  sessionId: string;
  seq: bigint;
  senderId: string;
  clientMessageId: string;
  type: string;
  body: string | null;
  bodyText: string | null;
  payload: Prisma.InputJsonValue | undefined;
  metadata: Prisma.InputJsonValue;
  threadRootId: string | null;
  createdAt: Date;
}

/** The message and its revision 1. */
export const insert = async (
  tx: Tx,
  input: InsertMessageInput
): Promise<Message> => {
  const message = await tx.message.create({ data: input });
  await tx.messageRevision.create({
    data: {
      messageId: message.id,
      revision: 1,
      body: input.body,
      payload: input.payload,
      editedBy: input.senderId,
      editedAt: input.createdAt,
    },
  });
  return message;
};

/** What decides whether a mentioned principal reads the session, and how to name and notify them. */
export interface MentionedPrincipal {
  id: string;
  displayName: string | null;
  tereoUserId: string | null;
  isBot: boolean;
  /** `null` when not a current participant. */
  participantRole: ParticipantRole | null;
  notify: NotifyLevel | null;
  /** `null` when not a member of the session's space (or it has none). */
  spaceRole: SpaceRole | null;
}

/** One query for every id; ids that name no principal are left out. */
export const mentionedPrincipals = async (
  tx: Tx,
  session: { id: string; spaceId: string | null },
  ids: string[]
): Promise<MentionedPrincipal[]> => {
  if (ids.length === 0) return [];
  return tx.$queryRaw<MentionedPrincipal[]>`
    SELECT p.id::text AS id, p.display_name AS "displayName",
      p.tereo_user_id::text AS "tereoUserId", p.is_bot AS "isBot",
      sp.role::text AS "participantRole", sp.notify::text AS notify,
      sm.role::text AS "spaceRole"
    FROM "chat"."principals" p
    LEFT JOIN "chat"."session_participants" sp
      ON sp.session_id = ${session.id}::uuid AND sp.user_id = p.id
      AND sp.left_at IS NULL
    LEFT JOIN "chat"."space_members" sm
      ON sm.space_id = ${session.spaceId}::uuid AND sm.user_id = p.id
    WHERE p.id = ANY(${ids}::uuid[])`;
};

export const insertMentions = async (
  tx: Tx,
  message: { id: string; sessionId: string },
  userIds: string[],
  broadcast: Pick<ParsedMentions, "here" | "session">
): Promise<void> => {
  const base = { messageId: message.id, sessionId: message.sessionId };
  const data: Prisma.MessageMentionCreateManyInput[] = [
    ...userIds.map((userId) => ({ ...base, kind: "user" as const, userId })),
    ...(broadcast.here ? [{ ...base, kind: "here" as const }] : []),
    ...(broadcast.session ? [{ ...base, kind: "session" as const }] : []),
  ];
  if (data.length > 0) await tx.messageMention.createMany({ data });
};

/** The session a message belongs to, to lock its space before the message is read under lock. */
export const sessionIdOf = async (
  client: Client,
  id: string
): Promise<string | null> =>
  (
    await client.message.findUnique({
      where: { id },
      select: { sessionId: true },
    })
  )?.sessionId ?? null;

/** The principals the message's stored `<@id>` mentions name. */
export const mentionedUserIds = async (
  tx: Tx,
  messageId: string
): Promise<string[]> =>
  (
    await tx.messageMention.findMany({
      where: { messageId, kind: "user" },
      select: { userId: true },
    })
  ).flatMap((m) => (m.userId === null ? [] : [m.userId]));

/** Clears the content; revisions, reactions and attachments stay. */
export const markDeleted = (
  tx: Tx,
  id: string,
  by: string,
  at: Date
): Promise<Message> =>
  tx.message.update({
    where: { id },
    data: {
      body: null,
      bodyText: null,
      payload: PrismaValues.DbNull,
      deletedAt: at,
      deletedBy: by,
    },
  });

export const deleteMentions = async (
  tx: Tx,
  messageId: string
): Promise<void> => {
  await tx.messageMention.deleteMany({ where: { messageId } });
};

/** Counts a reply on its root; returns the root's new count and time. */
export const countReply = async (
  tx: Tx,
  rootId: string,
  at: Date
): Promise<{ replyCount: number; lastReplyAt: Date }> => {
  const rows = await tx.$queryRaw<
    Array<{ reply_count: number; last_reply_at: Date }>
  >`
    UPDATE "chat"."messages"
    SET reply_count = reply_count + 1, last_reply_at = ${at}
    WHERE id = ${rootId}::uuid
    RETURNING reply_count, last_reply_at`;
  return {
    replyCount: rows[0].reply_count,
    lastReplyAt: rows[0].last_reply_at,
  };
};

/**
 * Takes a deleted reply off its root. `lastReplyAt` falls back to the newest
 * reply still standing, or `null` when none is.
 */
export const uncountReply = async (
  tx: Tx,
  rootId: string
): Promise<{ replyCount: number; lastReplyAt: Date | null }> => {
  const rows = await tx.$queryRaw<
    Array<{ reply_count: number; last_reply_at: Date | null }>
  >`
    UPDATE "chat"."messages"
    SET reply_count = GREATEST(reply_count - 1, 0),
        last_reply_at = (
          SELECT max(created_at) FROM "chat"."messages"
          WHERE thread_root_id = ${rootId}::uuid AND deleted_at IS NULL)
    WHERE id = ${rootId}::uuid
    RETURNING reply_count, last_reply_at`;
  return {
    replyCount: rows[0].reply_count,
    lastReplyAt: rows[0].last_reply_at,
  };
};

/**
 * The root's sender follows the thread (an earlier unfollow stands); the
 * replier follows it again and has read up to their reply.
 */
export const followOnReply = async (
  tx: Tx,
  rootId: string,
  rootSenderId: string,
  replierId: string,
  seq: bigint
): Promise<void> => {
  if (rootSenderId !== replierId) {
    await tx.threadFollower.upsert({
      where: {
        threadRootId_userId: { threadRootId: rootId, userId: rootSenderId },
      },
      create: { threadRootId: rootId, userId: rootSenderId, following: true },
      update: {},
    });
  }
  await tx.threadFollower.upsert({
    where: { threadRootId_userId: { threadRootId: rootId, userId: replierId } },
    create: {
      threadRootId: rootId,
      userId: replierId,
      following: true,
      lastReadSeq: seq,
    },
    update: { following: true, lastReadSeq: seq },
  });
};

/** Moves a participant's read position forward to `seq`. */
export const markRead = async (
  tx: Tx,
  sessionId: string,
  userId: string,
  seq: bigint
): Promise<void> => {
  await tx.sessionParticipant.updateMany({
    where: { sessionId, userId, lastReadSeq: { lt: seq } },
    data: { lastReadSeq: seq },
  });
};

export type PageQuery =
  | { before: number; limit: number }
  | { after: number; limit: number }
  | { around: number; limit: number }
  | { limit: number };

export interface Page {
  rows: Message[];
  hasBefore: boolean;
  hasAfter: boolean;
}

const topLevel = (sessionId: string) => ({ sessionId, threadRootId: null });

/** Up to `take` top-level messages below (`lt`) or from (`gte`) `seq`, nearest first, plus whether more lie beyond. */
const side = async (
  client: Client,
  sessionId: string,
  direction: "older" | "newer",
  bound: Prisma.BigIntFilter | undefined,
  take: number
): Promise<{ rows: Message[]; more: boolean }> => {
  const rows = await client.message.findMany({
    where: { ...topLevel(sessionId), seq: bound },
    orderBy: { seq: direction === "older" ? "desc" : "asc" },
    take: take + 1,
  });
  const more = rows.length > take;
  return { rows: rows.slice(0, take), more };
};

/** A page of top-level messages, ascending by `seq`. */
export const listPage = async (
  sessionId: string,
  q: PageQuery,
  client: Client = prisma
): Promise<Page> => {
  if ("around" in q) {
    const newerTake = Math.ceil(q.limit / 2);
    const older = await side(
      client,
      sessionId,
      "older",
      { lt: q.around },
      q.limit - newerTake
    );
    const newer = await side(
      client,
      sessionId,
      "newer",
      { gte: q.around },
      newerTake
    );
    return {
      rows: [...older.rows.reverse(), ...newer.rows],
      hasBefore: older.more,
      hasAfter: newer.more,
    };
  }
  if ("after" in q) {
    const newer = await side(
      client,
      sessionId,
      "newer",
      { gt: q.after },
      q.limit
    );
    const older = await side(client, sessionId, "older", { lte: q.after }, 0);
    return { rows: newer.rows, hasBefore: older.more, hasAfter: newer.more };
  }
  const before = "before" in q ? q.before : undefined;
  const older = await side(
    client,
    sessionId,
    "older",
    before === undefined ? undefined : { lt: before },
    q.limit
  );
  const newer =
    before === undefined
      ? { more: false }
      : await side(client, sessionId, "newer", { gte: before }, 0);
  return {
    rows: older.rows.reverse(),
    hasBefore: older.more,
    hasAfter: newer.more,
  };
};
