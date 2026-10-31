import type { prisma, Prisma } from "./prisma.js";
import type {
  ParticipantRole,
  SessionParticipant,
} from "../../../prisma/generated/client/index.js";

type Tx = Prisma.TransactionClient;
type Client = Tx | typeof prisma;

/** Where a page starts: after this row in `joined_at, user_id` order. */
export interface ParticipantPageStart {
  joinedAt: Date;
  principalId: string;
}

/** Current participants of a session, oldest first, with their principal. */
export const listCurrent = (
  client: Client,
  sessionId: string,
  after: ParticipantPageStart | undefined,
  take: number
) =>
  client.sessionParticipant.findMany({
    where: {
      sessionId,
      leftAt: null,
      ...(after && {
        OR: [
          { joinedAt: { gt: after.joinedAt } },
          { joinedAt: after.joinedAt, userId: { gt: after.principalId } },
        ],
      }),
    },
    include: { user: true },
    orderBy: [{ joinedAt: "asc" }, { userId: "asc" }],
    take,
  });

/** The current participant row, or `null` for a principal who never joined or has left. */
export const findCurrent = async (
  tx: Tx,
  sessionId: string,
  userId: string
): Promise<SessionParticipant | null> => {
  const row = await tx.sessionParticipant.findUnique({
    where: { sessionId_userId: { sessionId, userId } },
  });
  return row && row.leftAt === null ? row : null;
};

/**
 * Moves the participant's read position to `GREATEST(current, LEAST(seq, last_seq))` and
 * returns the position before and after, or `null` when they are not a current participant.
 */
export const advanceRead = async (
  tx: Tx,
  sessionId: string,
  userId: string,
  seq: number
): Promise<{ before: bigint; after: bigint } | null> => {
  const locked = await tx.$queryRaw<Array<{ last_read_seq: bigint }>>`
    SELECT last_read_seq FROM "chat"."session_participants"
    WHERE session_id = ${sessionId}::uuid AND user_id = ${userId}::uuid AND left_at IS NULL
    FOR UPDATE`;
  if (locked.length === 0) return null;
  const moved = await tx.$queryRaw<Array<{ last_read_seq: bigint }>>`
    UPDATE "chat"."session_participants" p
    SET last_read_seq = GREATEST(p.last_read_seq, LEAST(${seq}::bigint, s.last_seq))
    FROM "chat"."sessions" s
    WHERE s.id = p.session_id AND p.session_id = ${sessionId}::uuid
      AND p.user_id = ${userId}::uuid
    RETURNING p.last_read_seq`;
  return { before: locked[0].last_read_seq, after: moved[0].last_read_seq };
};

/**
 * Passes ownership to the current participant who joined first when the session has no
 * current `owner` left. Locks the owner rows (after the session row) so two leavers cannot
 * both decide there is none. Returns the promoted row, if any.
 */
export const promoteIfNoOwner = async (
  tx: Tx,
  sessionId: string
): Promise<SessionParticipant | null> => {
  const owners = await tx.$queryRaw<Array<{ user_id: string }>>`
    SELECT user_id FROM "chat"."session_participants"
    WHERE session_id = ${sessionId}::uuid AND role = ${"owner" satisfies ParticipantRole}::"chat"."participant_role"
      AND left_at IS NULL
    FOR UPDATE`;
  if (owners.length > 0) return null;
  const next = await tx.sessionParticipant.findFirst({
    where: { sessionId, leftAt: null },
    orderBy: [{ joinedAt: "asc" }, { userId: "asc" }],
  });
  if (!next) return null;
  return tx.sessionParticipant.update({
    where: { sessionId_userId: { sessionId, userId: next.userId } },
    data: { role: "owner" },
  });
};
