import type { MentionedPrincipal } from "./db/messages.js";
import type { Prisma } from "./db/prisma.js";
import { getTereo } from "./tereo.js";
import { logger } from "./logger.js";
import { redis } from "./redis.js";
import env from "../env.js";

/** How much of `body_text` a mention's email carries. */
const NOTIFICATION_TEXT_MAX = 500;

/** The most mention emails one send or edit queues; the other readers still get the mention. */
export const MENTION_EMAILS_MAX = 25;

export const mentionCooldownKey = (senderId: string, readerId: string) =>
  `${env.SERVICE_NAME}:mention-email:${senderId}:${readerId}`;

/** How long a send or edit waits on the cooldown, under its session lock, before skipping it. */
export const MENTION_COOLDOWN_TIMEOUT_MS = 200;

// Sets each key NX in order until ARGV[2] are set; returns their 1-based positions.
const TAKE_COOLDOWNS = `
local taken = {}
for i, key in ipairs(KEYS) do
  if #taken >= tonumber(ARGV[2]) then break end
  if redis.call("SET", key, "1", "EX", ARGV[1], "NX") then
    taken[#taken + 1] = i
  end
end
return taken`;

const TIMED_OUT = Symbol("timed out");

/**
 * The first `max` of `readers` not emailed a mention from `senderId` within
 * the cooldown, each now marked as emailed (and still marked if the
 * transaction rolls back). When Redis is not ready, fails or is slower than
 * `MENTION_COOLDOWN_TIMEOUT_MS`, the cooldown is skipped: the cap still bounds
 * the emails.
 */
export const outOfCooldown = async (
  senderId: string,
  readers: MentionedPrincipal[],
  max: number
): Promise<MentionedPrincipal[]> => {
  const seconds = env.MENTION_EMAIL_COOLDOWN_SECONDS;
  // Not ready, a command waits in the offline queue, holding the transaction open.
  if (seconds === 0 || readers.length === 0 || redis.status !== "ready") {
    return readers.slice(0, max);
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    const taken = await Promise.race([
      redis.eval(
        TAKE_COOLDOWNS,
        readers.length,
        ...readers.map((r) => mentionCooldownKey(senderId, r.id)),
        seconds,
        max
      ) as Promise<number[]>,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(
          () => resolve(TIMED_OUT),
          MENTION_COOLDOWN_TIMEOUT_MS
        );
      }),
    ]);
    if (taken === TIMED_OUT) {
      logger.warn("Mention email cooldown timed out");
      return readers.slice(0, max);
    }
    return taken.map((i) => readers[i - 1]!);
  } catch (err) {
    logger.warn({ err }, "Mention email cooldown unavailable");
    return readers.slice(0, max);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Emails `readers` a mention, in the caller's transaction: the first
 * `MENTION_EMAILS_MAX` of them the sender has not mentioned within
 * `MENTION_EMAIL_COOLDOWN_SECONDS`. The sender, bots, and readers whose
 * `notify` is `none` or who have no tereo user get nothing.
 */
export const notifyMentioned = async (
  tx: Prisma.TransactionClient,
  input: {
    organizationId: string;
    senderId: string;
    senderName: string | null;
    bodyText: string | null;
    readers: MentionedPrincipal[];
  }
): Promise<void> => {
  const eligible = input.readers.filter(
    (reader) =>
      reader.id !== input.senderId &&
      !reader.isBot &&
      reader.notify !== "none" &&
      reader.tereoUserId !== null
  );
  const subject = `${input.senderName ?? "Someone"} mentioned you`;
  const emailed = await outOfCooldown(
    input.senderId,
    eligible,
    MENTION_EMAILS_MAX
  );
  for (const reader of emailed) {
    await getTereo().outbox.notify(tx, {
      channel: "email",
      organizationId: input.organizationId,
      recipients: [{ userId: reader.tereoUserId! }],
      content: {
        subject,
        text: (input.bodyText ?? "").slice(0, NOTIFICATION_TEXT_MAX),
      },
    });
  }
};
