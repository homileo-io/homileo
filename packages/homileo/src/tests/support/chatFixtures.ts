import { prisma } from "../../utils/db/prisma.js";
import { v7 as uuidv7 } from "uuid";

/** Rows created for a test; `cleanup()` removes them, children first. */
export const chatFixtures = () => {
  const principals: string[] = [];
  const spaces: string[] = [];
  const sessions: string[] = [];

  const principal = async () => {
    const row = await prisma.principal.create({
      data: { kind: "user", tereoUserId: uuidv7() },
    });
    principals.push(row.id);
    return row;
  };

  const space = async (kind: string, archived = false) => {
    const creator = await principal();
    const row = await prisma.space.create({
      data: {
        organizationId: uuidv7(),
        kind,
        name: "fixture",
        createdBy: creator.id,
        archivedAt: archived ? new Date() : null,
      },
    });
    spaces.push(row.id);
    return row;
  };

  /** A message of `type` in a new session of its own. */
  const message = async (type: string) => {
    const creator = await principal();
    const session = await prisma.session.create({
      data: {
        organizationId: uuidv7(),
        type: "group",
        createdBy: creator.id,
      },
    });
    sessions.push(session.id);
    return prisma.message.create({
      data: {
        sessionId: session.id,
        seq: 1,
        senderId: creator.id,
        clientMessageId: uuidv7(),
        type,
        body: "fixture",
      },
    });
  };

  const cleanup = async () => {
    await prisma.message.deleteMany({ where: { sessionId: { in: sessions } } });
    await prisma.session.deleteMany({ where: { id: { in: sessions } } });
    await prisma.space.deleteMany({ where: { id: { in: spaces } } });
    await prisma.principal.deleteMany({ where: { id: { in: principals } } });
  };

  return { principal, space, message, cleanup };
};
