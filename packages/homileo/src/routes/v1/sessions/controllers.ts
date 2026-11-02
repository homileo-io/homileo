import { CreateSessionBodySchema, ListSessionsQuerySchema } from "./schemas.js";
import { validateBody, validateQuery } from "../../../utils/validateReq.js";
import { readableSessions, readableSpace } from "../../../utils/access.js";
import { approvePendingJoinRequest } from "../../../utils/joinRequests.js";
import { participantView, sessionView } from "../../../views/session.js";
import type { ListSessionsScope } from "../../../utils/db/sessions.js";
import { encodeSessionCursor, parseSessionCursor } from "./utils.js";
import { callerOf, type Caller } from "../../../middleware/auth.js";
import { prisma, type Prisma } from "../../../utils/db/prisma.js";
import { BUILTIN_KIND } from "../../../definitions/builtins.js";
import { assertState } from "../../../utils/spaceSettings.js";
import { withChanges } from "../../../utils/transaction.js";
import { memberView } from "../../../views/space.js";
import type { Request, Response } from "express";
import { db } from "../../../utils/db/index.js";
import {
  createSessionRefusal,
  readsEverySessionOf,
  type SpaceFacts,
} from "../../../policy/index.js";
import {
  ArchivedError,
  ForbiddenError,
  NotFoundError,
  PostingRestrictedError,
  ValidationError,
} from "../../../utils/errors.js";

const listScope = async (
  caller: Caller,
  query: { spaceId?: string; externalRef?: string }
): Promise<ListSessionsScope> => {
  if (query.spaceId !== undefined) {
    const { facts } = await readableSpace(caller, query.spaceId);
    return {
      spaceId: query.spaceId,
      everything: readsEverySessionOf(caller, facts),
    };
  }
  // A reference names sessions in any space, so it searches every readable session.
  if (query.externalRef !== undefined) return { readable: true };
  return { participating: true };
};

export const listSessions = async (req: Request, res: Response) => {
  const caller = callerOf(req);
  const query = validateQuery(ListSessionsQuerySchema, req);
  const after = query.cursor ? parseSessionCursor(query.cursor) : undefined;

  const rows = await db.sessions.list(prisma, {
    caller,
    scope: await listScope(caller, query),
    type: query.type,
    externalRef: query.externalRef,
    includeArchived: query.includeArchived,
    after,
    take: query.limit + 1,
  });
  const page = rows.slice(0, query.limit);
  // Participation alone does not make a session readable; a dropped row still moves the cursor.
  const readable = await readableSessions(
    caller,
    page.map((r) => r.id)
  );
  res.status(200).json({
    data: await withParticipants(
      caller,
      page.filter((r) => readable.has(r.id))
    ),
    nextCursor:
      rows.length > query.limit
        ? encodeSessionCursor(page[page.length - 1])
        : null,
  });
};

const withParticipants = async (
  caller: Caller,
  rows: Awaited<ReturnType<typeof db.sessions.list>>
) => {
  const mine = await db.sessions.participantsOf(
    prisma,
    caller.principalId,
    rows.map((r) => r.id)
  );
  return rows.map((row) => {
    const participant = mine.get(row.id);
    return {
      ...sessionView(row),
      participant: participant ? participantView(participant) : null,
    };
  });
};

const invalidIds = (message: string, indexes: number[]) =>
  new ValidationError(
    "Invalid request body.",
    indexes.map((i) => ({ path: `participantIds.${i}`, message }))
  );

const refuseCreateIn = (caller: Caller, space: SpaceFacts): void => {
  switch (createSessionRefusal(caller, space)) {
    case null:
      return;
    case "not_found":
      throw new NotFoundError("Space not found");
    case "archived":
      throw new ArchivedError("The space is archived");
    case "posting_restricted":
      throw new PostingRestrictedError(
        "Only moderators start sessions in this space"
      );
    case "not_a_member":
      throw new ForbiddenError("You are not a member of this space");
  }
};

export const createSession = async (req: Request, res: Response) => {
  const caller = callerOf(req);
  const body = validateBody(CreateSessionBodySchema, req);
  const participantIds = body.participantIds ?? [];

  const session = await withChanges(async (tx, record) => {
    const space = body.spaceId
      ? await readableSpace(caller, body.spaceId, { tx, lock: true })
      : null;
    if (space) refuseCreateIn(caller, space.facts);

    const unknown = await db.sessions.unknownPrincipalIndexes(
      tx,
      participantIds
    );
    if (unknown.length > 0) {
      throw invalidIds("No such principal", unknown);
    }
    if (space) {
      const outsiders = await db.sessions.nonMemberIndexes(
        tx,
        space.space.id,
        participantIds
      );
      if (outsiders.length > 0) {
        throw invalidIds("Not a member of the space", outsiders);
      }
    }

    const kind = space?.facts.kind ?? BUILTIN_KIND;
    assertState(kind, body.state);

    const row = await tx.session.create({
      data: {
        organizationId: caller.organizationId,
        spaceId: space?.space.id ?? null,
        type: "group",
        access: space ? (body.access ?? "space") : "members",
        name: body.name ?? null,
        state: body.state ?? null,
        externalRef: body.externalRef ?? null,
        metadata: (body.metadata ?? {}) as Prisma.InputJsonValue,
        createdBy: caller.principalId,
      },
    });
    await record({
      type: "session.created",
      organizationId: row.organizationId,
      spaceId: row.spaceId,
      sessionId: row.id,
      actorId: caller.principalId,
      entity: { type: "session", id: row.id },
      payload: { session: sessionView(row) },
      audit: { action: "CREATE", userId: caller.tereoUserId },
    });

    const botIds: string[] = [];
    if (space && kind.bots.length > 0) {
      // In the transaction, sorted, so creates take the principals' rows in one order.
      const bots = await db.principals.ensureBotPrincipals(
        [...kind.bots].sort(),
        tx
      );
      const members = new Set(
        (
          await tx.spaceMember.findMany({
            where: {
              spaceId: space.space.id,
              userId: { in: bots.map((b) => b.id) },
            },
            select: { userId: true },
          })
        ).map((m) => m.userId)
      );
      for (const bot of bots) {
        botIds.push(bot.id);
        if (members.has(bot.id)) continue;
        const member = await tx.spaceMember.create({
          data: { spaceId: space.space.id, userId: bot.id, role: "member" },
        });
        await record({
          type: "space.member_added",
          organizationId: row.organizationId,
          spaceId: space.space.id,
          actorId: caller.principalId,
          entity: { type: "space", id: space.space.id },
          payload: { spaceId: space.space.id, member: memberView(member) },
        });
        await approvePendingJoinRequest(
          tx,
          record,
          {
            organizationId: row.organizationId,
            spaceId: space.space.id,
            actorId: caller.principalId,
          },
          bot.id
        );
      }
    }

    const add = (ids: string[], role: "owner" | "member") =>
      db.sessions.addParticipants(
        tx,
        record,
        row,
        ids,
        role,
        caller.principalId
      );
    await add([caller.principalId], space ? "member" : "owner");
    await add([...participantIds, ...botIds], "member");
    return row;
  });

  res.status(201).json({ session: sessionView(session) });
};
