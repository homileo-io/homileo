import type { OrgCaller } from "../middleware/auth.js";
import type { Prisma } from "../utils/db/prisma.js";

// The read rules as Prisma conditions, for queries the caller's organization already limits.
// `grantedKinds` are the kinds one of whose grants the caller holds (`kindsGrantingRead`):
// loading them is the caller's I/O, so these stay pure.

export const memberOfWhere = (principalId: string): Prisma.SpaceWhereInput => ({
  members: { some: { userId: principalId } },
});

export const participatesWhere = (
  principalId: string
): Prisma.SessionWhereInput => ({
  participants: { some: { userId: principalId, leftAt: null } },
});

/** `canReadSpace`: an admin reads every space of the organization. */
export const readableSpaceWhere = (
  c: OrgCaller,
  grantedKinds: string[]
): Prisma.SpaceWhereInput => {
  if (c.isAdmin) return {};
  return {
    OR: [
      memberOfWhere(c.principalId),
      { visibility: "public" },
      ...(grantedKinds.length > 0 ? [{ kind: { in: grantedKinds } }] : []),
    ],
  };
};

/** `canReadSession`; the `access: members` branch for non-participants is `readsEverySessionOf`. */
export const readableSessionWhere = (
  c: OrgCaller,
  grantedKinds: string[]
): Prisma.SessionWhereInput => {
  const mine = participatesWhere(c.principalId);
  const membersBranch: Prisma.SessionWhereInput[] = c.isAdmin
    ? [{ access: "members" }]
    : [
        { access: "members", ...mine },
        ...(grantedKinds.length > 0
          ? [
              {
                access: "members" as const,
                space: { kind: { in: grantedKinds } },
              },
            ]
          : []),
      ];
  return {
    OR: [
      { spaceId: null, ...mine },
      {
        spaceId: { not: null },
        space: readableSpaceWhere(c, grantedKinds),
        OR: [{ access: "space" }, ...membersBranch],
      },
    ],
  };
};

/**
 * The sessions of one space the caller can read, given they read the space; `readsEvery` is
 * `readsEverySessionOf` for it.
 */
export const spaceSessionsWhere = (
  c: OrgCaller,
  spaceId: string,
  readsEvery: boolean
): Prisma.SessionWhereInput => ({
  spaceId,
  ...(readsEvery
    ? {}
    : { OR: [{ access: "space" }, participatesWhere(c.principalId)] }),
});
