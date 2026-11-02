import { Prisma } from "../../prisma/generated/client/index.js";
import type { OrgCaller } from "../middleware/auth.js";

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

const ALIAS = /^[a-z_][a-z0-9_]*$/;

const aliasSql = (alias: string): Prisma.Sql => {
  if (!ALIAS.test(alias)) throw new Error(`invalid SQL alias: ${alias}`);
  return Prisma.raw(alias);
};

/**
 * `readableSpaceWhere` as raw SQL over `"chat"."spaces" <alias>`. Unlike the Prisma form it
 * includes the organization, since a raw query has no filter to lean on.
 */
export const readableSpaceSql = (
  c: OrgCaller,
  grantedKinds: string[],
  alias: string
): Prisma.Sql => {
  const a = aliasSql(alias);
  const org = Prisma.sql`${a}.organization_id = ${c.organizationId}::uuid`;
  if (c.isAdmin) return org;
  const branches = [
    Prisma.sql`EXISTS (SELECT 1 FROM "chat"."space_members" sm WHERE sm.space_id = ${a}.id AND sm.user_id = ${c.principalId}::uuid)`,
    Prisma.sql`${a}.visibility = 'public'::"chat"."space_visibility"`,
    ...(grantedKinds.length > 0
      ? [Prisma.sql`${a}.kind = ANY(${grantedKinds}::text[])`]
      : []),
  ];
  return Prisma.sql`(${org} AND (${Prisma.join(branches, " OR ")}))`;
};

/**
 * `readableSessionWhere` as raw SQL over `"chat"."sessions" <alias>`, including the
 * organization. The space is reached through `readableSpaceSql` on an inner alias.
 */
export const readableSessionSql = (
  c: OrgCaller,
  grantedKinds: string[],
  alias: string
): Prisma.Sql => {
  const a = aliasSql(alias);
  const org = Prisma.sql`${a}.organization_id = ${c.organizationId}::uuid`;
  const members = Prisma.sql`${a}.access = 'members'::"chat"."session_access"`;
  const participates = Prisma.sql`EXISTS (SELECT 1 FROM "chat"."session_participants" sp WHERE sp.session_id = ${a}.id AND sp.user_id = ${c.principalId}::uuid AND sp.left_at IS NULL)`;
  const membersBranch = c.isAdmin
    ? [members]
    : [
        Prisma.sql`(${members} AND ${participates})`,
        ...(grantedKinds.length > 0
          ? [
              Prisma.sql`(${members} AND EXISTS (SELECT 1 FROM "chat"."spaces" gs WHERE gs.id = ${a}.space_id AND gs.kind = ANY(${grantedKinds}::text[])))`,
            ]
          : []),
      ];
  const inSpace = Prisma.sql`(${a}.space_id IS NOT NULL AND EXISTS (SELECT 1 FROM "chat"."spaces" rs WHERE rs.id = ${a}.space_id AND ${readableSpaceSql(c, grantedKinds, "rs")}) AND (${Prisma.join(
    [
      Prisma.sql`${a}.access = 'space'::"chat"."session_access"`,
      ...membersBranch,
    ],
    " OR "
  )}))`;
  return Prisma.sql`(${org} AND ((${a}.space_id IS NULL AND ${participates}) OR ${inSpace}))`;
};
