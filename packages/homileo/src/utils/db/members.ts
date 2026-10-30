import { prisma, type Prisma } from "./prisma.js";
import type {
  Principal,
  SpaceMember,
  SpaceRole,
} from "../../../prisma/generated/client/index.js";

export interface MemberListFilter {
  role?: SpaceRole;
  /** `joined_at` and principal id of the last row of the previous page. */
  after?: { joinedAt: Date; principalId: string };
  limit: number;
}

export interface MemberPage {
  rows: Array<SpaceMember & { user: Principal }>;
  hasMore: boolean;
}

/** A space's members, oldest first, with one extra row's worth of `hasMore`. */
export const listPage = async (
  spaceId: string,
  filter: MemberListFilter
): Promise<MemberPage> => {
  const after = filter.after;
  const found = await prisma.spaceMember.findMany({
    where: {
      spaceId,
      ...(filter.role !== undefined && { role: filter.role }),
      ...(after && {
        OR: [
          { joinedAt: { gt: after.joinedAt } },
          { joinedAt: after.joinedAt, userId: { gt: after.principalId } },
        ],
      }),
    },
    include: { user: true },
    orderBy: [{ joinedAt: "asc" }, { userId: "asc" }],
    take: filter.limit + 1,
  });
  return {
    rows: found.slice(0, filter.limit),
    hasMore: found.length > filter.limit,
  };
};

/**
 * Locks the space's owner rows and returns their principal ids. Take it after
 * the space row, so a change that would leave no owner sees every concurrent one.
 */
export const lockOwners = async (
  tx: Prisma.TransactionClient,
  spaceId: string
): Promise<string[]> =>
  (
    await tx.$queryRaw<Array<{ user_id: string }>>`
      SELECT user_id FROM "chat"."space_members"
      WHERE space_id = ${spaceId}::uuid AND role = 'owner' FOR UPDATE`
  ).map((row) => row.user_id);

/**
 * Locks, in id order, the sessions of the space the principal takes part in,
 * and returns their ids. A send to one waits for the removal that follows.
 */
export const lockActiveSessions = async (
  tx: Prisma.TransactionClient,
  spaceId: string,
  principalId: string
): Promise<string[]> =>
  (
    await tx.$queryRaw<Array<{ id: string }>>`
      SELECT s.id FROM "chat"."sessions" s
      JOIN "chat"."session_participants" sp ON sp.session_id = s.id
      WHERE s.space_id = ${spaceId}::uuid AND sp.user_id = ${principalId}::uuid
        AND sp.left_at IS NULL
      ORDER BY s.id FOR UPDATE OF s`
  ).map((row) => row.id);
