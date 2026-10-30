import type { Principal } from "../../../prisma/generated/client/index.js";
import type { AuthServiceUser } from "@tereo-io/sdk";
import { getTereo } from "../tereo.js";
import { logger } from "../logger.js";
import { prisma } from "./prisma.js";
import { v7 as uuidv7 } from "uuid";
import { redis } from "../redis.js";
import env from "../../env.js";

export type { Principal };

/** Long enough to cover one lookup; the stamp keeps the profile fresh after it. */
const REFRESH_LOCK_SECONDS = 30;

type ProfileLookup = (tereoUserId: string) => Promise<AuthServiceUser | null>;

let lookupProfile: ProfileLookup = (id) => getTereo().auth.getUser(id);

/** Replaces tereo's user lookup; `null` restores it. Only tests call this. */
export const setProfileLookup = (lookup: ProfileLookup | null) => {
  lookupProfile = lookup ?? ((id) => getTereo().auth.getUser(id));
};

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
      ${input.displayName}, NOW(), NOW())
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
        displayName: user.name ?? principal.displayName,
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
