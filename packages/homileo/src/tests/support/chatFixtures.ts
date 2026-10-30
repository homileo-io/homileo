import { prisma } from "../../utils/db/prisma.js";
import { v7 as uuidv7 } from "uuid";
import type {
  JoinPolicy,
  ParticipantRole,
  PostPolicy,
  Principal,
  Session,
  SessionAccess,
  SessionType,
  Space,
  SpaceRole,
  SpaceVisibility,
} from "../../../prisma/generated/client/index.js";

export interface SpaceOptions {
  org?: string;
  kind?: string;
  name?: string;
  visibility?: SpaceVisibility;
  joinPolicy?: JoinPolicy;
  postPolicy?: PostPolicy;
  archived?: boolean;
  createdBy?: Principal;
}

export interface SessionOptions {
  /** Defaults to the space's organization, else a fresh one. */
  org?: string;
  space?: Space;
  type?: SessionType;
  access?: SessionAccess;
  archived?: boolean;
  createdBy?: Principal;
}

/** Rows created for a test; `cleanup()` removes them, children first. */
export const chatFixtures = () => {
  const principals: string[] = [];
  const spaces: string[] = [];
  const sessions: string[] = [];
  const organizations: string[] = [];

  /** Spaces made through the API in this organization are removed by `cleanup()` too. */
  const organization = (id: string) => {
    organizations.push(id);
  };

  const principal = async (o: { isBot?: boolean } = {}) => {
    const row = await prisma.principal.create({
      data: { kind: "user", tereoUserId: uuidv7(), isBot: o.isBot ?? false },
    });
    principals.push(row.id);
    return row;
  };

  /** `space("support:case", true)` is shorthand for `space({ kind, archived })`. */
  const space = async (
    kindOrOptions: string | SpaceOptions = {},
    archived = false
  ): Promise<Space> => {
    const o: SpaceOptions =
      typeof kindOrOptions === "string"
        ? { kind: kindOrOptions, archived }
        : kindOrOptions;
    const creator = o.createdBy ?? (await principal());
    const row = await prisma.space.create({
      data: {
        organizationId: o.org ?? uuidv7(),
        kind: o.kind ?? "default",
        name: o.name ?? "fixture",
        visibility: o.visibility,
        joinPolicy: o.joinPolicy,
        postPolicy: o.postPolicy,
        createdBy: creator.id,
        archivedAt: o.archived ? new Date() : null,
      },
    });
    spaces.push(row.id);
    return row;
  };

  const member = (
    spaceRow: Pick<Space, "id">,
    who: Pick<Principal, "id">,
    role: SpaceRole = "member"
  ) =>
    prisma.spaceMember.create({
      data: { spaceId: spaceRow.id, userId: who.id, role },
    });

  const session = async (o: SessionOptions = {}): Promise<Session> => {
    const creator = o.createdBy ?? (await principal());
    const row = await prisma.session.create({
      data: {
        organizationId: o.space?.organizationId ?? o.org ?? uuidv7(),
        spaceId: o.space?.id ?? null,
        type: o.type ?? "group",
        access: o.access,
        createdBy: creator.id,
        archivedAt: o.archived ? new Date() : null,
      },
    });
    sessions.push(row.id);
    return row;
  };

  const participant = (
    sessionRow: Pick<Session, "id">,
    who: Pick<Principal, "id">,
    role: ParticipantRole = "member",
    o: { left?: boolean } = {}
  ) =>
    prisma.sessionParticipant.create({
      data: {
        sessionId: sessionRow.id,
        userId: who.id,
        role,
        leftAt: o.left ? new Date() : null,
      },
    });

  /** A message of `type` in a new session of its own. */
  const message = async (type: string) => {
    const creator = await principal();
    const row = await session({ createdBy: creator });
    return prisma.message.create({
      data: {
        sessionId: row.id,
        seq: 1,
        senderId: creator.id,
        clientMessageId: uuidv7(),
        type,
        body: "fixture",
      },
    });
  };

  const cleanup = async () => {
    spaces.push(
      ...(
        await prisma.space.findMany({
          where: { organizationId: { in: organizations } },
          select: { id: true },
        })
      ).map((s) => s.id)
    );
    // Sessions a test made through the API in a fixture space count too.
    const owned = (
      await prisma.session.findMany({
        where: { OR: [{ id: { in: sessions } }, { spaceId: { in: spaces } }] },
        select: { id: true },
      })
    ).map((s) => s.id);
    const messageIds = (
      await prisma.message.findMany({
        where: { sessionId: { in: owned } },
        select: { id: true },
      })
    ).map((m) => m.id);
    const byMessage = { messageId: { in: messageIds } };
    await prisma.reaction.deleteMany({ where: byMessage });
    await prisma.messageMention.deleteMany({
      where: { OR: [byMessage, { sessionId: { in: owned } }] },
    });
    await prisma.messageRevision.deleteMany({ where: byMessage });
    await prisma.attachment.deleteMany({ where: byMessage });
    await prisma.threadFollower.deleteMany({
      where: { threadRootId: { in: messageIds } },
    });
    // Replies point at their root with RESTRICT.
    await prisma.message.deleteMany({
      where: { sessionId: { in: owned }, threadRootId: { not: null } },
    });
    await prisma.message.deleteMany({ where: { sessionId: { in: owned } } });
    await prisma.sessionParticipant.deleteMany({
      where: { sessionId: { in: owned } },
    });
    await prisma.session.deleteMany({ where: { id: { in: owned } } });
    await prisma.spaceJoinRequest.deleteMany({
      where: { spaceId: { in: spaces } },
    });
    await prisma.spaceMember.deleteMany({ where: { spaceId: { in: spaces } } });
    await prisma.space.deleteMany({ where: { id: { in: spaces } } });
    await prisma.principal.deleteMany({ where: { id: { in: principals } } });
  };

  return {
    organization,
    principal,
    space,
    member,
    session,
    participant,
    message,
    cleanup,
  };
};
