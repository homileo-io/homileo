import type { SessionFacts, SpaceFacts, SpaceRole } from "../policy/index.js";
import type { MentionedPrincipal } from "./db/messages.js";
import { BUILTIN_KIND } from "../definitions/builtins.js";
import { prisma, type Prisma } from "./db/prisma.js";
import type { Caller } from "../middleware/auth.js";
import { NotFoundError } from "./errors.js";
import { getKind } from "./kinds.js";
import { logger } from "./logger.js";
import type {
  Message,
  Session,
  SessionParticipant,
  Space,
} from "../../prisma/generated/client/index.js";
import {
  canReadSession,
  canReadSpace,
  isMentionReader,
} from "../policy/index.js";

type Tx = Prisma.TransactionClient;

export type SessionRow = Session;
export type MessageRow = Message;

export interface SpaceContext {
  space: Space;
  facts: SpaceFacts;
}

export interface SessionContext {
  session: SessionRow;
  space: Space | null;
  facts: SessionFacts;
  /** The caller's participant row; `null` when they never joined or have left. */
  participant: SessionParticipant | null;
}

export interface MessageContext extends SessionContext {
  message: MessageRow;
}

export interface LoadOptions {
  /** Load inside this transaction, so the checks and the write see the same rows. */
  tx?: Tx;
  /** `SELECT … FOR UPDATE` on the session (or space) row; needs `tx`. */
  lock?: boolean;
}

export interface SessionLoadOptions extends LoadOptions {
  /**
   * Lets a `homileo.chat.admin` of the session's organization load it without reading it: an
   * admin archives any session and removes participants of space-less ones it cannot read.
   * Only for those routes; the policy still decides the action.
   */
  adminManage?: boolean;
}

// One message for every refusal, so a caller learns nothing from which it was.
const spaceNotFound = () => new NotFoundError("Space not found");
const sessionNotFound = () => new NotFoundError("Session not found");
const messageNotFound = () => new NotFoundError("Message not found");

const clientOf = (opts: LoadOptions): Tx | typeof prisma => {
  if (opts.lock && !opts.tx) {
    throw new Error("Loading with a lock needs a transaction (`tx`)");
  }
  return opts.tx ?? prisma;
};

/** The facts of `space` for the caller; `role` is their membership, `null` for none. */
export const spaceFactsFor = async (
  _c: Caller,
  space: Space,
  role: SpaceRole | null
): Promise<SpaceFacts> => {
  let kind = await getKind(space.kind);
  if (!kind) {
    logger.warn(
      { spaceId: space.id, kind: space.kind },
      "Space has a kind with no row; using the built-in kind"
    );
    kind = BUILTIN_KIND;
  }
  return {
    organizationId: space.organizationId,
    kind,
    visibility: space.visibility,
    joinPolicy: space.joinPolicy,
    postPolicy: space.postPolicy,
    archived: space.archivedAt !== null,
    role,
  };
};

const roleIn = async (
  client: Tx | typeof prisma,
  spaceId: string,
  principalId: string
): Promise<SpaceRole | null> =>
  (
    await client.spaceMember.findUnique({
      where: { spaceId_userId: { spaceId, userId: principalId } },
      select: { role: true },
    })
  )?.role ?? null;

export const readableSpace = async (
  c: Caller,
  spaceId: string,
  opts: LoadOptions = {}
): Promise<SpaceContext> => {
  const client = clientOf(opts);
  if (opts.lock) {
    await (client as Tx).$queryRaw`
      SELECT id FROM "chat"."spaces" WHERE id = ${spaceId}::uuid FOR UPDATE`;
  }
  const space = await client.space.findUnique({ where: { id: spaceId } });
  if (!space || space.organizationId !== c.organizationId) {
    throw spaceNotFound();
  }
  const facts = await spaceFactsFor(
    c,
    space,
    await roleIn(client, space.id, c.principalId)
  );
  if (!canReadSpace(c, facts)) throw spaceNotFound();
  return { space, facts };
};

const sessionContext = async (
  c: Caller,
  session: SessionRow,
  client: Tx | typeof prisma,
  adminManage = false
): Promise<SessionContext | null> => {
  if (session.organizationId !== c.organizationId) return null;
  const space = session.spaceId
    ? await client.space.findUnique({ where: { id: session.spaceId } })
    : null;
  const spaceFacts = space
    ? await spaceFactsFor(
        c,
        space,
        await roleIn(client, space.id, c.principalId)
      )
    : null;
  const row = await client.sessionParticipant.findUnique({
    where: {
      sessionId_userId: { sessionId: session.id, userId: c.principalId },
    },
  });
  // A participant who left is, to the policy, no participant.
  const participant = row && row.leftAt === null ? row : null;
  const facts: SessionFacts = {
    organizationId: session.organizationId,
    type: session.type,
    space: spaceFacts,
    access: session.access,
    archived: session.archivedAt !== null,
    participantRole: participant?.role ?? null,
  };
  if (!canReadSession(c, facts) && !(adminManage && c.isAdmin)) return null;
  return { session, space, facts, participant };
};

const lockSession = async (tx: Tx, sessionId: string): Promise<void> => {
  await tx.$queryRaw`
    SELECT id FROM "chat"."sessions" WHERE id = ${sessionId}::uuid FOR UPDATE`;
};

export const readableSession = async (
  c: Caller,
  sessionId: string,
  opts: SessionLoadOptions = {}
): Promise<SessionContext> => {
  const client = clientOf(opts);
  if (opts.lock) await lockSession(client as Tx, sessionId);
  const session = await client.session.findUnique({ where: { id: sessionId } });
  const context = session
    ? await sessionContext(c, session, client, opts.adminManage)
    : null;
  if (!context) throw sessionNotFound();
  return context;
};

export const readableMessage = async (
  c: Caller,
  messageId: string,
  opts: LoadOptions = {}
): Promise<MessageContext> => {
  const client = clientOf(opts);
  let message = await client.message.findUnique({ where: { id: messageId } });
  if (!message) throw messageNotFound();
  if (opts.lock) {
    // The session row is what serializes writers; the message is read again under it.
    await lockSession(client as Tx, message.sessionId);
    message = await client.message.findUnique({ where: { id: messageId } });
    if (!message) throw messageNotFound();
  }
  const session = await client.session.findUnique({
    where: { id: message.sessionId },
  });
  const context = session ? await sessionContext(c, session, client) : null;
  if (!context) throw messageNotFound();
  return { ...context, message };
};

/** The mentioned principals the policy counts as readers of the session (`isMentionReader`). */
export const mentionReaders = (
  context: SessionContext,
  principals: MentionedPrincipal[]
): MentionedPrincipal[] =>
  principals.filter((p) => isMentionReader(context.facts, p));

/**
 * The sessions among `sessionIds` the caller can read now, in their organization,
 * by session id. Loads the sessions, spaces and the caller's memberships and
 * participation in bulk rather than one `readableSession` per row.
 */
export const readableSessions = async (
  c: Caller,
  sessionIds: string[]
): Promise<Map<string, SessionRow>> => {
  const readable = new Map<string, SessionRow>();
  if (sessionIds.length === 0) return readable;
  const sessions = await prisma.session.findMany({
    where: { id: { in: sessionIds }, organizationId: c.organizationId },
  });
  const spaceIds = [
    ...new Set(sessions.flatMap((s) => (s.spaceId ? [s.spaceId] : []))),
  ];
  const [spaces, members, participants] = await Promise.all([
    prisma.space.findMany({ where: { id: { in: spaceIds } } }),
    prisma.spaceMember.findMany({
      where: { spaceId: { in: spaceIds }, userId: c.principalId },
    }),
    prisma.sessionParticipant.findMany({
      where: {
        sessionId: { in: sessions.map((s) => s.id) },
        userId: c.principalId,
        leftAt: null,
      },
    }),
  ]);
  const spaceOf = new Map(spaces.map((s) => [s.id, s]));
  const roleOf = new Map(members.map((m) => [m.spaceId, m.role]));
  const participantOf = new Map(participants.map((p) => [p.sessionId, p]));
  const spaceFacts = new Map<string, SpaceFacts>();
  for (const space of spaces) {
    spaceFacts.set(
      space.id,
      await spaceFactsFor(c, space, roleOf.get(space.id) ?? null)
    );
  }
  for (const session of sessions) {
    if (session.spaceId && !spaceOf.has(session.spaceId)) continue;
    const facts: SessionFacts = {
      organizationId: session.organizationId,
      type: session.type,
      space: session.spaceId ? (spaceFacts.get(session.spaceId) ?? null) : null,
      access: session.access,
      archived: session.archivedAt !== null,
      participantRole: participantOf.get(session.id)?.role ?? null,
    };
    if (canReadSession(c, facts)) readable.set(session.id, session);
  }
  return readable;
};
