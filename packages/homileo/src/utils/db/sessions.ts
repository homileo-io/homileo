import type { ChangeEvent, ChangeInput } from "../changes.js";
import { participantView } from "../../views/session.js";
import type { Caller } from "../../middleware/auth.js";
import type { prisma, Prisma } from "./prisma.js";
import { grantedKindsOf } from "./spaces.js";
import { v7 as uuidv7 } from "uuid";
import type {
  ParticipantRole,
  Session,
  SessionParticipant,
  SessionType,
} from "../../../prisma/generated/client/index.js";
import {
  participatesWhere,
  readableSessionWhere,
  spaceSessionsWhere,
} from "../../policy/sql.js";

type Tx = Prisma.TransactionClient;
type Client = Tx | typeof prisma;
type Record = (change: ChangeInput) => Promise<ChangeEvent>;

/**
 * Inserts or re-joins one participant. `joined_at` is the database's `now()`, the clock
 * `chat.events.created_at` comes from, because fan-out compares the two; Prisma would fill
 * `@default(now())` from the app's clock.
 */
const joinParticipant = async (
  tx: Tx,
  sessionId: string,
  userId: string,
  role: ParticipantRole
): Promise<SessionParticipant> => {
  const [row] = await tx.$queryRaw<SessionParticipant[]>`
    INSERT INTO "chat"."session_participants" (session_id, user_id, role, joined_at)
    VALUES (${sessionId}::uuid, ${userId}::uuid,
      ${role}::"chat"."participant_role", now())
    ON CONFLICT (session_id, user_id) DO UPDATE
      SET left_at = NULL, joined_at = now(), role = EXCLUDED.role
    RETURNING session_id::text AS "sessionId", user_id::text AS "userId",
      role::text AS role, last_read_seq AS "lastReadSeq", notify::text AS notify,
      joined_at AS "joinedAt", left_at AS "leftAt"`;
  return row;
};

/**
 * Makes each principal a participant of `session` and records `session.participant_added`
 * for those it added. A row with `left_at` set is re-joined (its read position stays);
 * current participants are left as they are. Returns the rows it added.
 */
export const addParticipants = async (
  tx: Tx,
  record: Record,
  session: Pick<Session, "id" | "organizationId" | "spaceId">,
  principalIds: string[],
  role: ParticipantRole,
  actorId: string
): Promise<SessionParticipant[]> => {
  const ids = [...new Set(principalIds)];
  const existing = new Map(
    (
      await tx.sessionParticipant.findMany({
        where: { sessionId: session.id, userId: { in: ids } },
      })
    ).map((row) => [row.userId, row])
  );

  const added: SessionParticipant[] = [];
  for (const userId of ids) {
    const current = existing.get(userId);
    if (current && current.leftAt === null) continue;
    const row = await joinParticipant(tx, session.id, userId, role);
    added.push(row);
    await record({
      type: "session.participant_added",
      organizationId: session.organizationId,
      spaceId: session.spaceId,
      sessionId: session.id,
      actorId,
      entity: { type: "session", id: session.id },
      payload: { sessionId: session.id, participant: participantView(row) },
    });
  }
  return added;
};

/**
 * Locks the session's space row `FOR SHARE`, which comes before the session row in the lock
 * order: the space stays as it is while a session-level change runs, and such changes in
 * different sessions of the space run together. A session of another organization locks nothing.
 */
export const lockSpaceOf = async (
  tx: Tx,
  organizationId: string,
  sessionId: string
): Promise<void> => {
  await tx.$queryRaw`
    SELECT sp.id FROM "chat"."spaces" sp
    JOIN "chat"."sessions" s ON s.space_id = sp.id
    WHERE s.id = ${sessionId}::uuid AND s.organization_id = ${organizationId}::uuid
    FOR SHARE OF sp`;
};

/** The session's space and access, or `null` when there is no such session. */
export const accessOf = (
  tx: Tx,
  sessionId: string
): Promise<{ spaceId: string | null; access: "space" | "members" } | null> =>
  tx.session.findUnique({
    where: { id: sessionId },
    select: { spaceId: true, access: true },
  });

/** `accessOf` for many sessions at once, keyed by id; an unknown id is absent. */
export const accessOfMany = async (
  tx: Tx,
  sessionIds: string[]
): Promise<
  Map<string, { spaceId: string | null; access: "space" | "members" }>
> =>
  new Map(
    (
      await tx.session.findMany({
        where: { id: { in: sessionIds } },
        select: { id: true, spaceId: true, access: true },
      })
    ).map(({ id, ...access }) => [id, access])
  );

/** The indexes in `ids` that name no principal. */
export const unknownPrincipalIndexes = async (
  tx: Tx,
  ids: string[]
): Promise<number[]> => {
  const known = new Set(
    (
      await tx.principal.findMany({
        where: { id: { in: ids } },
        select: { id: true },
      })
    ).map((p) => p.id)
  );
  return ids.flatMap((id, i) => (known.has(id) ? [] : [i]));
};

export const principalExists = async (tx: Tx, id: string): Promise<boolean> =>
  (await tx.principal.count({ where: { id } })) > 0;

/** The indexes in `ids` whose principal is not a member of the space. */
export const nonMemberIndexes = async (
  tx: Tx,
  spaceId: string,
  ids: string[]
): Promise<number[]> => {
  const members = new Set(
    (
      await tx.spaceMember.findMany({
        where: { spaceId, userId: { in: ids } },
        select: { userId: true },
      })
    ).map((m) => m.userId)
  );
  return ids.flatMap((id, i) => (members.has(id) ? [] : [i]));
};

/** Inserts the DM unless the organization has one for the pair; `null` when it does. */
export const insertDirect = async (
  tx: Tx,
  input: {
    organizationId: string;
    directKey: string;
    createdBy: string;
  }
): Promise<Session | null> => {
  const id = uuidv7();
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    INSERT INTO "chat"."sessions"
      (id, organization_id, type, access, direct_key, created_by, created_at, updated_at)
    VALUES (${id}::uuid, ${input.organizationId}::uuid,
      ${"direct" satisfies SessionType}::"chat"."session_type", 'members',
      ${input.directKey}, ${input.createdBy}::uuid, NOW(), NOW())
    ON CONFLICT ("organization_id", "direct_key") WHERE "direct_key" IS NOT NULL
    DO NOTHING
    RETURNING id`;
  if (rows.length === 0) return null;
  return tx.session.findUniqueOrThrow({ where: { id } });
};

/** The organization's DM for the pair, its row locked `FOR UPDATE`. */
export const lockDirect = async (
  tx: Tx,
  organizationId: string,
  directKey: string
): Promise<Session | null> => {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "chat"."sessions"
    WHERE organization_id = ${organizationId}::uuid AND direct_key = ${directKey}
    FOR UPDATE`;
  if (rows.length === 0) return null;
  return tx.session.findUniqueOrThrow({ where: { id: rows[0].id } });
};

/** Where a page starts: after this row in `last_message_at DESC NULLS LAST, created_at DESC, id DESC`. */
export interface SessionPageStart {
  lastMessageAt: Date | null;
  createdAt: Date;
  id: string;
}

export type ListSessionsScope =
  /** The sessions of a space the caller can read; `everything` skips the participation test. */
  | { spaceId: string; everything: boolean }
  /** The sessions the caller participates in. */
  | { participating: true }
  /** Every session of the organization the caller can read (`readableSessionWhere`). */
  | { readable: true };

export interface ListSessionsInput {
  caller: Caller;
  scope: ListSessionsScope;
  type?: SessionType;
  externalRef?: string;
  includeArchived: boolean;
  after?: SessionPageStart;
  take: number;
}

/**
 * The rest of a non-null `last_message_at` run after `a`, or the rest of the null run. Each is
 * one range of the list index (`last_message_at <= a`, or `IS NULL` and `created_at <= a`), so a
 * deep page seeks; the OR alone is only a filter.
 */
const afterCondition = (a: SessionPageStart): Prisma.SessionWhereInput => {
  const tie: Prisma.SessionWhereInput = {
    createdAt: { lte: a.createdAt },
    OR: [
      { createdAt: { lt: a.createdAt } },
      { createdAt: a.createdAt, id: { lt: a.id } },
    ],
  };
  if (a.lastMessageAt === null) return { lastMessageAt: null, ...tie };
  return {
    lastMessageAt: { lte: a.lastMessageAt },
    OR: [
      { lastMessageAt: { lt: a.lastMessageAt } },
      { lastMessageAt: a.lastMessageAt, AND: [tie] },
    ],
  };
};

const scopeWhere = async (
  input: ListSessionsInput
): Promise<Prisma.SessionWhereInput> => {
  const { scope, caller } = input;
  if ("spaceId" in scope) {
    return spaceSessionsWhere(caller, scope.spaceId, scope.everything);
  }
  if ("participating" in scope) return participatesWhere(caller.principalId);
  return readableSessionWhere(caller, await grantedKindsOf(caller));
};

const ORDER: Prisma.SessionOrderByWithRelationInput[] = [
  { lastMessageAt: { sort: "desc", nulls: "last" } },
  { createdAt: "desc" },
  { id: "desc" },
];

export const list = async (
  client: Client,
  input: ListSessionsInput
): Promise<Session[]> => {
  const scope = await scopeWhere(input);
  const base: Prisma.SessionWhereInput = {
    organizationId: input.caller.organizationId,
    ...(input.type && { type: input.type }),
    ...(input.externalRef !== undefined && {
      externalRef: input.externalRef,
    }),
    ...(!input.includeArchived && { archivedAt: null }),
  };
  const page = (after: Prisma.SessionWhereInput[], take: number) =>
    client.session.findMany({
      where: { ...base, AND: [scope, ...after] },
      orderBy: ORDER,
      take,
    });
  const after = input.after;
  if (!after || after.lastMessageAt === null) {
    return page(after ? [afterCondition(after)] : [], input.take);
  }
  // Past a dated row, the dated rest and then the undated rows: one index range each.
  const dated = await page([afterCondition(after)], input.take);
  if (dated.length >= input.take) return dated;
  const undated = await page(
    [{ lastMessageAt: null }],
    input.take - dated.length
  );
  return [...dated, ...undated];
};

/** The principal's current participant rows among `sessionIds`, by session id. */
export const participantsOf = async (
  client: Client,
  principalId: string,
  sessionIds: string[]
): Promise<Map<string, SessionParticipant>> =>
  new Map(
    (
      await client.sessionParticipant.findMany({
        where: {
          userId: principalId,
          leftAt: null,
          sessionId: { in: sessionIds },
        },
      })
    ).map((row) => [row.sessionId, row])
  );
