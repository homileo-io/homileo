import type { MentionedPrincipal } from "./db/messages.js";
import type { Prisma } from "./db/prisma.js";
import { getTereo } from "./tereo.js";

/** How much of `body_text` a mention's email carries. */
const NOTIFICATION_TEXT_MAX = 500;

/**
 * Emails each of `readers` a mention, in the caller's transaction. The sender,
 * bots, and readers whose `notify` is `none` or who have no tereo user get
 * nothing.
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
  const subject = `${input.senderName ?? "Someone"} mentioned you`;
  for (const reader of input.readers) {
    if (
      reader.id === input.senderId ||
      reader.isBot ||
      reader.notify === "none" ||
      reader.tereoUserId === null
    ) {
      continue;
    }
    await getTereo().outbox.notify(tx, {
      channel: "email",
      organizationId: input.organizationId,
      recipients: [{ userId: reader.tereoUserId }],
      content: {
        subject,
        text: (input.bodyText ?? "").slice(0, NOTIFICATION_TEXT_MAX),
      },
    });
  }
};
