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

const cooldownKey = (senderId: string, readerId: string) =>
  `${env.SERVICE_NAME}:mention-email:${senderId}:${readerId}`;

/**
 * Of `readers`, those not emailed a mention from `senderId` within the
 * cooldown, each now marked as emailed (and still marked if the transaction
 * rolls back). Without Redis all of them are: the per-message cap still
 * bounds the emails.
 */
const outOfCooldown = async (
  senderId: string,
  readers: MentionedPrincipal[]
): Promise<MentionedPrincipal[]> => {
  const seconds = env.MENTION_EMAIL_COOLDOWN_SECONDS;
  // Not ready, a command waits in the offline queue, holding the transaction open.
  if (seconds === 0 || readers.length === 0 || redis.status !== "ready") {
    return readers;
  }
  const pipeline = redis.pipeline();
  for (const r of readers) {
    pipeline.set(cooldownKey(senderId, r.id), "1", "EX", seconds, "NX");
  }
  try {
    const results = (await pipeline.exec()) ?? [];
    return readers.filter((_, i) => {
      const [err, reply] = results[i] ?? [null, "OK"];
      return err !== null || reply === "OK";
    });
  } catch (err) {
    logger.warn({ err }, "Mention email cooldown unavailable");
    return readers;
  }
};

/**
 * Emails `readers` a mention, in the caller's transaction: at most
 * `MENTION_EMAILS_MAX` of them, and none the sender mentioned within
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
  const eligible = input.readers
    .filter(
      (reader) =>
        reader.id !== input.senderId &&
        !reader.isBot &&
        reader.notify !== "none" &&
        reader.tereoUserId !== null
    )
    .slice(0, MENTION_EMAILS_MAX);
  const subject = `${input.senderName ?? "Someone"} mentioned you`;
  for (const reader of await outOfCooldown(input.senderId, eligible)) {
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
