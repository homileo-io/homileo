// @module-tag int
// @module-tag messages
import { chatFixtures } from "../../support/chatFixtures.js";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../../../utils/db/prisma.js";
import { db } from "../../../utils/db/index.js";

const fixtures = chatFixtures();

afterAll(async () => {
  await fixtures.cleanup();
});

describe("db.messages.loadViews", () => {
  it("pairs each summary with the reactionSeq read beside it, not the row's", async () => {
    const message = await fixtures.message("text");
    const reactor = await fixtures.principal();
    // A reaction that commits after the caller read the message row.
    await prisma.reaction.create({
      data: { messageId: message.id, userId: reactor.id, emoji: "👍" },
    });
    await prisma.message.update({
      where: { id: message.id },
      data: { reactionSeq: { increment: 1 } },
    });

    const [view] = await db.messages.loadViews(prisma, [message]);

    expect(message.reactionSeq).toBe(0n);
    expect(view.reactionSeq).toBe(1);
    expect(view.reactions).toEqual([
      { emoji: "👍", count: 1, principalIds: [reactor.id] },
    ]);
  });

  it("gives a message with no reactions an empty summary and its reactionSeq", async () => {
    const message = await fixtures.message("text");

    const [view] = await db.messages.loadViews(prisma, [message]);

    expect(view.reactions).toEqual([]);
    expect(view.reactionSeq).toBe(0);
  });
});
