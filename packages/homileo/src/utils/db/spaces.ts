import { memberOfWhere, readableSpaceWhere } from "../../policy/sql.js";
import type { Space } from "../../../prisma/generated/client/index.js";
import type { SpaceRole } from "../../policy/index.js";
import type { Caller } from "../../middleware/auth.js";
import { prisma, type Prisma } from "./prisma.js";
import { kindsGrantingRead } from "../kinds.js";

export interface SpaceListFilter {
  kind?: string;
  externalRef?: string;
  membership: "member" | "readable";
  includeArchived: boolean;
  /** `created_at` and id of the last row of the previous page. */
  after?: { createdAt: Date; id: string };
  limit: number;
}

export interface SpacePage {
  rows: Space[];
  hasMore: boolean;
  /** The caller's role in each of `rows`. */
  roles: Map<string, SpaceRole>;
}

/** The kinds whose grants give the caller read; an admin reads everything without them. */
export const grantedKindsOf = async (caller: Caller): Promise<string[]> =>
  caller.isAdmin ? [] : kindsGrantingRead(caller.permissions);

/** Whose spaces `membership` lists: the caller's own, or everything they may read. */
const readableBy = async (
  caller: Caller,
  membership: SpaceListFilter["membership"]
): Promise<Prisma.SpaceWhereInput> =>
  membership === "member"
    ? memberOfWhere(caller.principalId)
    : readableSpaceWhere(caller, await grantedKindsOf(caller));

/** The caller's organization's spaces they asked for, newest first, with one extra row's worth of `hasMore`. */
export const listPage = async (
  caller: Caller,
  filter: SpaceListFilter
): Promise<SpacePage> => {
  const and: Prisma.SpaceWhereInput[] = [
    await readableBy(caller, filter.membership),
  ];
  if (filter.after) {
    and.push({
      // Redundant with the OR, which the index cannot seek on; this range it can.
      createdAt: { lte: filter.after.createdAt },
      OR: [
        { createdAt: { lt: filter.after.createdAt } },
        { createdAt: filter.after.createdAt, id: { lt: filter.after.id } },
      ],
    });
  }
  const found = await prisma.space.findMany({
    where: {
      organizationId: caller.organizationId,
      ...(filter.kind !== undefined && { kind: filter.kind }),
      ...(filter.externalRef !== undefined && {
        externalRef: filter.externalRef,
      }),
      ...(!filter.includeArchived && { archivedAt: null }),
      AND: and,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: filter.limit + 1,
  });
  const rows = found.slice(0, filter.limit);
  const memberships = await prisma.spaceMember.findMany({
    where: {
      userId: caller.principalId,
      spaceId: { in: rows.map((r) => r.id) },
    },
    select: { spaceId: true, role: true },
  });
  return {
    rows,
    hasMore: found.length > filter.limit,
    roles: new Map(memberships.map((m) => [m.spaceId, m.role])),
  };
};
