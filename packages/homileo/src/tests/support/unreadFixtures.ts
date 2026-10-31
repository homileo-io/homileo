import { prisma } from "../../utils/db/prisma.js";
import { v7 as uuidv7 } from "uuid";

/** Inserts messages straight into a session, keeping `last_seq` and the thread counters consistent. */
export const seedMessages = () => {
  const lastSeq = new Map<string, number>();

  const add = async (
    sessionId: string,
    senderId: string,
    o: {
      threadRootId?: string;
      deleted?: boolean;
      mentions?: Array<{ kind: "user" | "here" | "session"; userId?: string }>;
    } = {}
  ) => {
    const seq = (lastSeq.get(sessionId) ?? 0) + 1;
    lastSeq.set(sessionId, seq);
    const row = await prisma.message.create({
      data: {
        sessionId,
        seq,
        senderId,
        clientMessageId: uuidv7(),
        type: "text",
        body: "fixture",
        bodyText: "fixture",
        threadRootId: o.threadRootId ?? null,
        deletedAt: o.deleted ? new Date() : null,
      },
    });
    for (const m of o.mentions ?? []) {
      await prisma.messageMention.create({
        data: {
          messageId: row.id,
          sessionId,
          kind: m.kind,
          userId: m.userId ?? null,
        },
      });
    }
    await prisma.session.update({
      where: { id: sessionId },
      data: { lastSeq: seq },
    });
    return row;
  };

  /** Removes everything `add` made; run it before the fixtures' own cleanup. */
  const cleanup = async () => {
    const ids = [...lastSeq.keys()];
    const where = { sessionId: { in: ids } };
    await prisma.messageMention.deleteMany({ where });
    await prisma.threadFollower.deleteMany({
      where: { threadRoot: where },
    });
    await prisma.message.deleteMany({
      where: { sessionId: { in: ids }, threadRootId: { not: null } },
    });
    await prisma.message.deleteMany({ where });
  };

  const many = async (sessionId: string, senderId: string, count: number) => {
    for (let i = 0; i < count; i++) await add(sessionId, senderId);
  };

  return { add, many, cleanup };
};
