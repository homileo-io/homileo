import type { ChangeEvent, ChangeInput } from "../changes.js";
import { participantView } from "../../views/session.js";
import type { prisma, Prisma } from "./prisma.js";
import { v7 as uuidv7 } from "uuid";
import type {
  ParticipantRole,
  Session,
  SessionParticipant,
  SessionType,
} from "../../../prisma/generated/client/index.js";

type Tx = Prisma.TransactionClient;
type Client = Tx | typeof prisma;
type Record = (change: ChangeInput) => Promise<ChangeEvent>;

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
    const row = current
      ? await tx.sessionParticipant.update({
          where: { sessionId_userId: { sessionId: session.id, userId } },
          data: { leftAt: null, joinedAt: new Date(), role },
        })
      : await tx.sessionParticipant.create({
          data: { sessionId: session.id, userId, role },
        });
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
 * Locks the session's space row, which comes before the session row in the lock order. `share`
 * keeps the space as it is while a session-level change runs, and lets such changes in different
 * sessions of the space run together; `update` is for changing the space or its members.
 */
export const lockSpaceOf = async (
  tx: Tx,
  sessionId: string,
  mode: "share" | "update"
): Promise<void> => {
  if (mode === "update") {
    await tx.$queryRaw`
      SELECT sp.id FROM "chat"."spaces" sp
      JOIN "chat"."sessions" s ON s.space_id = sp.id
      WHERE s.id = ${sessionId}::uuid
      FOR UPDATE OF sp`;
    return;
  }
  await tx.$queryRaw`
    SELECT sp.id FROM "chat"."spaces" sp
    JOIN "chat"."sessions" s ON s.space_id = sp.id
    WHERE s.id = ${sessionId}::uuid
    FOR SHARE OF sp`;
};

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

export const findDirect = (
  tx: Tx,
  organizationId: string,
  directKey: string
): Promise<Session | null> =>
  tx.session.findFirst({ where: { organizationId, directKey } });

/** Where a page starts: after this row in `last_message_at DESC NULLS LAST, created_at DESC, id DESC`. */
export interface SessionPageStart {
  lastMessageAt: Date | null;
  createdAt: Date;
  id: string;
}

export interface ListSessionsInput {
  organizationId: string;
  principalId: string;
  /** Only the sessions of this space. */
  spaceId?: string;
  /** Skips the participation test: every session of the space, or, without `spaceId`, of the organization. */
  everything?: boolean;
  type?: SessionType;
  externalRef?: string;
  includeArchived: boolean;
  after?: SessionPageStart;
  take: number;
}

const afterCondition = (a: SessionPageStart): Prisma.SessionWhereInput => {
  const tie: Prisma.SessionWhereInput[] = [
    { createdAt: { lt: a.createdAt } },
    { createdAt: a.createdAt, id: { lt: a.id } },
  ];
  if (a.lastMessageAt === null) {
    return { lastMessageAt: null, OR: tie };
  }
  return {
    OR: [
      { lastMessageAt: { lt: a.lastMessageAt } },
      { lastMessageAt: null },
      { lastMessageAt: a.lastMessageAt, OR: tie },
    ],
  };
};

const participates = (principalId: string): Prisma.SessionWhereInput => ({
  participants: { some: { userId: principalId, leftAt: null } },
});

export const list = (
  client: Client,
  input: ListSessionsInput
): Promise<Session[]> => {
  const scope: Prisma.SessionWhereInput = input.spaceId
    ? {
        spaceId: input.spaceId,
        ...(input.everything
          ? {}
          : {
              OR: [{ access: "space" }, participates(input.principalId)],
            }),
      }
    : input.everything
      ? {}
      : participates(input.principalId);
  return client.session.findMany({
    where: {
      organizationId: input.organizationId,
      ...(input.type && { type: input.type }),
      ...(input.externalRef !== undefined && {
        externalRef: input.externalRef,
      }),
      ...(!input.includeArchived && { archivedAt: null }),
      AND: [scope, ...(input.after ? [afterCondition(input.after)] : [])],
    },
    orderBy: [
      { lastMessageAt: { sort: "desc", nulls: "last" } },
      { createdAt: "desc" },
      { id: "desc" },
    ],
    take: input.take,
  });
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
