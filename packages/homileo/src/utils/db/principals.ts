import type { AuthServiceUser } from "@tereo-io/sdk";
import { getTereo } from "../tereo.js";
import { logger } from "../logger.js";
import { prisma } from "./prisma.js";
import { v7 as uuidv7 } from "uuid";
import { redis } from "../redis.js";
import env from "../../env.js";
import {
  Prisma,
  type Principal,
} from "../../../prisma/generated/client/index.js";

export type { Principal };

/** Long enough to cover one lookup; the stamp keeps the profile fresh after it. */
const REFRESH_LOCK_SECONDS = 30;

type ProfileLookup = (tereoUserId: string) => Promise<AuthServiceUser | null>;

let lookupProfile: ProfileLookup = (id) => getTereo().auth.getUser(id);

/** Replaces tereo's user lookup; `null` restores it. Only tests call this. */
export const setProfileLookup = (lookup: ProfileLookup | null) => {
  lookupProfile = lookup ?? ((id) => getTereo().auth.getUser(id));
};

type UsersLookup = (
  tereoUserIds: string[]
) => Promise<Map<string, AuthServiceUser | null>>;

let lookupUsers: UsersLookup = (ids) => getTereo().auth.getUsers(ids);

/** Replaces tereo's batch user lookup; `null` restores it. Only tests call this. */
export const setUsersLookup = (lookup: UsersLookup | null) => {
  lookupUsers = lookup ?? ((ids) => getTereo().auth.getUsers(ids));
};

const DISPLAY_NAME_MAX = 255;

/** Cuts by code point, so a surrogate pair is never split. */
export const truncateDisplayName = (name: string | null): string | null =>
  name === null ? null : Array.from(name).slice(0, DISPLAY_NAME_MAX).join("");

/**
 * Finds or creates the user principal of a tereo user. A known user is one
 * read; only a miss inserts, and requests that race on a first sign-in all
 * read back the one row that won.
 */
export const findOrCreateUser = async (input: {
  tereoUserId: string;
  isBot: boolean;
  displayName: string | null;
}): Promise<Principal> => {
  const where = { tereoUserId: input.tereoUserId };
  const found = await prisma.principal.findUnique({ where });
  if (found) return found;

  await prisma.$executeRaw`INSERT INTO "chat"."principals"
      (id, kind, tereo_user_id, is_bot, display_name, created_at, updated_at)
    VALUES (${uuidv7()}::uuid, 'user', ${input.tereoUserId}::uuid, ${input.isBot},
      ${truncateDisplayName(input.displayName)}, NOW(), NOW())
    ON CONFLICT (tereo_user_id) DO NOTHING`;
  return prisma.principal.findUniqueOrThrow({ where });
};

/** Never attempted, or last attempted longer ago than the TTL. */
export const isProfileStale = (principal: Principal, now = Date.now()) =>
  principal.tereoUserId !== null &&
  (principal.profileRefreshedAt === null ||
    now - principal.profileRefreshedAt.getTime() >=
      env.PRINCIPAL_PROFILE_TTL_SECONDS * 1000);

/**
 * Takes the display name and avatar from tereo. Every attempt is stamped, so a
 * user without a name, or a tereo outage, is not retried until the TTL passes;
 * a failed lookup keeps the cached values.
 */
export const refreshProfile = async (principal: Principal): Promise<void> => {
  if (!principal.tereoUserId) return;
  let user: AuthServiceUser | null = null;
  try {
    user = await lookupProfile(principal.tereoUserId);
  } catch (err) {
    logger.warn(
      { err, principalId: principal.id },
      "profile refresh failed; keeping cached values"
    );
  }
  // The lookup may also carry a photo; the installed SDK's user type has none.
  const photo = (user as { photo?: { url?: string } | string | null } | null)
    ?.photo;
  await prisma.principal.update({
    where: { id: principal.id },
    data: {
      profileRefreshedAt: new Date(),
      ...(user && {
        displayName: truncateDisplayName(user.name ?? principal.displayName),
        avatarUrl:
          (typeof photo === "string" ? photo : photo?.url) ??
          principal.avatarUrl,
      }),
    },
  });
};

/**
 * Refreshes a stale profile without holding up the request. The Redis key
 * lets one of several concurrent requests for the principal do it.
 */
export const refreshProfileInBackground = (principal: Principal): void => {
  if (!isProfileStale(principal)) return;
  void (async () => {
    const key = `homileo:principal-refresh:${principal.id}`;
    const won = await redis.set(key, "1", "EX", REFRESH_LOCK_SECONDS, "NX");
    if (won) await refreshProfile(principal);
  })().catch((err: unknown) => {
    logger.error(
      { err, principalId: principal.id },
      "background profile refresh failed"
    );
  });
};

export const resolveUsers = (tereoUserIds: string[]): Promise<Principal[]> =>
  prisma.principal.findMany({
    where: { tereoUserId: { in: tereoUserIds } },
  });

export interface NewUserPrincipal {
  tereoUserId: string;
  isBot: boolean;
  displayName: string | null;
}

/**
 * Creates the principals that do not exist yet in one insert, then reads all
 * of them back in the order given. Existing rows are left as they are, and
 * callers racing on the same ids all read the rows that won.
 */
export const findOrCreateMany = async (
  users: NewUserPrincipal[],
  client: Prisma.TransactionClient | typeof prisma = prisma
): Promise<Principal[]> => {
  const unique = [...new Map(users.map((u) => [u.tereoUserId, u])).values()];
  if (unique.length === 0) return [];

  await client.$executeRaw`INSERT INTO "chat"."principals"
      (id, kind, tereo_user_id, is_bot, display_name, created_at, updated_at)
    VALUES ${Prisma.join(
      unique.map(
        (u) =>
          Prisma.sql`(${uuidv7()}::uuid, 'user', ${u.tereoUserId}::uuid, ${u.isBot},
            ${truncateDisplayName(u.displayName)}, NOW(), NOW())`
      )
    )}
    ON CONFLICT (tereo_user_id) DO NOTHING`;

  const rows = await client.principal.findMany({
    where: { tereoUserId: { in: unique.map((u) => u.tereoUserId) } },
  });
  const byUser = new Map(rows.map((r) => [r.tereoUserId, r]));
  return unique.map((u) => byUser.get(u.tereoUserId)!);
};

/**
 * Principals for a kind's declared bots, created when unseen (in `client`, a
 * transaction when the caller holds one, so it needs no second connection). They are service
 * accounts by declaration, so tereo is not asked; a name arrives with their
 * first request.
 */
export const ensureBotPrincipals = (
  tereoUserIds: string[],
  client: Prisma.TransactionClient | typeof prisma = prisma
): Promise<Principal[]> =>
  findOrCreateMany(
    tereoUserIds.map((tereoUserId) => ({
      tereoUserId,
      isBot: true,
      displayName: null,
    })),
    client
  );

export interface ResolvedPrincipals {
  data: Principal[];
  missing: string[];
}

/**
 * The principals of tereo users, in the order asked. Known users are returned
 * as stored; only the unseen are looked up, and those tereo does not know are
 * listed in `missing`.
 */
export const resolveOrCreateUsers = async (
  tereoUserIds: string[]
): Promise<ResolvedPrincipals> => {
  const existing = await resolveUsers(tereoUserIds);
  const known = new Map(existing.map((p) => [p.tereoUserId, p]));
  const unseen = tereoUserIds.filter((id) => !known.has(id));

  const missing: string[] = [];
  if (unseen.length > 0) {
    const found = await lookupUsers(unseen);
    const toCreate: NewUserPrincipal[] = [];
    for (const id of unseen) {
      const user = found.get(id) ?? null;
      if (!user) missing.push(id);
      else
        toCreate.push({
          tereoUserId: id,
          isBot: user.userType === "service_account",
          displayName: user.name ?? null,
        });
    }
    for (const p of await findOrCreateMany(toCreate)) {
      known.set(p.tereoUserId, p);
    }
  }

  return {
    data: tereoUserIds.flatMap((id) => known.get(id) ?? []),
    missing,
  };
};
