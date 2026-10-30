import type { Principal } from "../../../prisma/generated/client/index.js";
import { getTereo } from "../tereo.js";
import { logger } from "../logger.js";
import { prisma } from "./prisma.js";
import { v7 as uuidv7 } from "uuid";
import env from "../../env.js";

export type { Principal };

/**
 * Finds or creates the user principal of a tereo user. The no-op update makes
 * RETURNING yield the existing row, so requests that race on a first sign-in
 * all converge on one principal.
 */
export const upsertUser = async (input: {
  tereoUserId: string;
  isBot: boolean;
}): Promise<Principal> => {
  const rows = await prisma.$queryRaw<
    Array<{ id: string }>
  >`INSERT INTO "chat"."principals" (id, kind, tereo_user_id, is_bot, created_at, updated_at)
    VALUES (${uuidv7()}::uuid, 'user', ${input.tereoUserId}::uuid, ${input.isBot}, NOW(), NOW())
    ON CONFLICT (tereo_user_id) DO UPDATE SET updated_at = principals.updated_at
    RETURNING id`;
  return prisma.principal.findUniqueOrThrow({ where: { id: rows[0].id } });
};

/**
 * Takes the display name and avatar from tereo when there are none yet or
 * they are older than the TTL. A failed lookup keeps the cached values.
 */
export const refreshProfile = async (
  principal: Principal
): Promise<Principal> => {
  if (!principal.tereoUserId) return principal;
  const ageMs = Date.now() - principal.updatedAt.getTime();
  const fresh =
    principal.displayName !== null &&
    ageMs < env.PRINCIPAL_PROFILE_TTL_SECONDS * 1000;
  if (fresh) return principal;

  try {
    const user = await getTereo().auth.getUser(principal.tereoUserId);
    if (!user) return principal;
    // The lookup may also carry a photo; the installed SDK's user type has none.
    const photo = (user as { photo?: { url?: string } | string | null }).photo;
    return await prisma.principal.update({
      where: { id: principal.id },
      data: {
        displayName: user.name ?? principal.displayName,
        avatarUrl:
          (typeof photo === "string" ? photo : photo?.url) ??
          principal.avatarUrl,
      },
    });
  } catch (err) {
    logger.warn(
      { err, principalId: principal.id },
      "profile refresh failed; keeping cached values"
    );
    return principal;
  }
};

export const resolveUsers = (tereoUserIds: string[]): Promise<Principal[]> =>
  prisma.principal.findMany({
    where: { tereoUserId: { in: tereoUserIds } },
  });
