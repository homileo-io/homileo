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

/** Whose spaces `membership` lists: the caller's own, or everything they may read. */
const readableBy = async (
  caller: Caller,
  membership: SpaceListFilter["membership"]
): Promise<Prisma.SpaceWhereInput> => {
  const member: Prisma.SpaceWhereInput = {
    members: { some: { userId: caller.principalId } },
  };
  if (membership === "member") return member;
  // An admin reads every space of the organization, which the where already limits to.
  if (caller.isAdmin) return {};
  const granted = await kindsGrantingRead(caller.permissions);
  return {
    OR: [
      member,
      { visibility: "public" },
      ...(granted.length > 0 ? [{ kind: { in: granted } }] : []),
    ],
  };
};

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
