import { CreateSessionBodySchema, ListSessionsQuerySchema } from "./schemas.js";
import { holdsKindGrant, canCreateSessionIn } from "../../../policy/index.js";
import { validateBody, validateQuery } from "../../../utils/validateReq.js";
import { readableSessions, readableSpace } from "../../../utils/access.js";
import { participantView, sessionView } from "../../../views/session.js";
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
  ArchivedError,
  ForbiddenError,
  PostingRestrictedError,
  ValidationError,
} from "../../../utils/errors.js";

/** Matches of one reference that are read before the caller's limit applies. */
const EXTERNAL_REF_SCAN_LIMIT = 1000;

export const listSessions = async (req: Request, res: Response) => {
  const caller = callerOf(req);
  const query = validateQuery(ListSessionsQuerySchema, req);
  const after = query.cursor ? parseSessionCursor(query.cursor) : undefined;

  const base = {
    organizationId: caller.organizationId,
    principalId: caller.principalId,
    type: query.type,
    externalRef: query.externalRef,
    includeArchived: query.includeArchived,
  };

  if (query.spaceId === undefined && query.externalRef !== undefined) {
    const rows = await db.sessions.list(prisma, {
      ...base,
      // Visibility here is per session, so the policy filters after the read.
      spaceId: undefined,
      everything: true,
      take: EXTERNAL_REF_SCAN_LIMIT,
    });
    const readable = await readableSessions(
      caller,
      rows.map((r) => r.id)
    );
    const visible = rows
      .filter((r) => readable.has(r.id))
      .slice(0, query.limit);
    res.status(200).json({
      data: await withParticipants(caller, visible),
      nextCursor: null,
    });
    return;
  }

  let everything = false;
  if (query.spaceId !== undefined) {
    const { facts } = await readableSpace(caller, query.spaceId);
    everything = holdsKindGrant(caller, facts) || caller.isAdmin;
  }
  const rows = await db.sessions.list(prisma, {
    ...base,
    spaceId: query.spaceId,
    everything,
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

export const createSession = async (req: Request, res: Response) => {
  const caller = callerOf(req);
  const body = validateBody(CreateSessionBodySchema, req);
  const participantIds = body.participantIds ?? [];

  const session = await withChanges(async (tx, record) => {
    const space = body.spaceId
      ? await readableSpace(caller, body.spaceId, { tx, lock: true })
      : null;
    if (space) {
      if (space.facts.archived) {
        throw new ArchivedError("The space is archived");
      }
      if (!canCreateSessionIn(caller, space.facts)) {
        if (space.facts.postPolicy === "moderators") {
          throw new PostingRestrictedError(
            "Only moderators start sessions in this space"
          );
        }
        throw new ForbiddenError("You are not a member of this space");
      }
    }

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
