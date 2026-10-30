import { validateBody, validateQuery } from "../../../utils/validateReq.js";
import { ensureBotPrincipals } from "../../../utils/db/principals.js";
import { encodeCursor, parseCursor } from "../../../utils/cursor.js";
import { mapUniqueViolation } from "../../../utils/prismaErrors.js";
import { BUILTIN_KIND } from "../../../definitions/builtins.js";
import { memberView, spaceView } from "../../../views/space.js";
import { withChanges } from "../../../utils/transaction.js";
import { BadRequestError } from "../../../utils/errors.js";
import type { Prisma } from "../../../utils/db/prisma.js";
import { callerOf } from "../../../middleware/auth.js";
import { activeKind } from "../../../utils/kinds.js";
import type { Request, Response } from "express";
import { db } from "../../../utils/db/index.js";
import {
  assertOverridable,
  assertState,
} from "../../../utils/spaceSettings.js";
import {
  CreateSpaceSchema,
  ListSpacesQuerySchema,
  SpaceCursorSchema,
} from "./schemas.js";

export const listSpaces = async (req: Request, res: Response) => {
  const caller = callerOf(req);
  const query = validateQuery(ListSpacesQuerySchema, req);
  let after: { createdAt: Date; id: string } | undefined;
  if (query.cursor !== undefined) {
    const [createdAt, id] = parseCursor(query.cursor, SpaceCursorSchema);
    after = { createdAt: new Date(createdAt), id };
  }

  const page = await db.spaces.listPage(caller, { ...query, after });
  const last = page.rows.at(-1);
  res.status(200).json({
    data: page.rows.map((row) => ({
      ...spaceView(row),
      role: page.roles.get(row.id) ?? null,
    })),
    nextCursor:
      page.hasMore && last
        ? encodeCursor([last.createdAt.toISOString(), last.id])
        : null,
  });
};

export const createSpace = async (req: Request, res: Response) => {
  const caller = callerOf(req);
  const body = validateBody(CreateSpaceSchema, req);

  const space = await withChanges(async (tx, record) => {
    const kind = await activeKind(tx, body.kind ?? BUILTIN_KIND.name);
    if (!kind) {
      throw new BadRequestError(
        "kind_not_found",
        `The kind "${body.kind}" does not exist or is retired`
      );
    }
    assertOverridable(kind, body);
    assertState(kind, body.state);

    // Sorted, so creates of different kinds take the principals' rows in one order.
    const bots = (await ensureBotPrincipals([...kind.bots].sort(), tx)).filter(
      (bot) => bot.id !== caller.principalId
    );

    const row = await mapUniqueViolation(
      () =>
        tx.space.create({
          data: {
            organizationId: caller.organizationId,
            kind: kind.name,
            name: body.name,
            description: body.description ?? null,
            visibility: body.visibility ?? kind.defaults.visibility,
            joinPolicy: body.joinPolicy ?? kind.defaults.join,
            postPolicy: body.postPolicy ?? kind.defaults.posting,
            state: body.state ?? null,
            externalRef: body.externalRef ?? null,
            metadata: (body.metadata ?? {}) as Prisma.InputJsonObject,
            createdBy: caller.principalId,
          },
        }),
      "A space of this kind with this externalRef already exists",
      "external_ref_taken"
    );

    const members = [
      await tx.spaceMember.create({
        data: { spaceId: row.id, userId: caller.principalId, role: "owner" },
      }),
    ];
    for (const bot of bots) {
      members.push(
        await tx.spaceMember.create({
          data: { spaceId: row.id, userId: bot.id, role: "member" },
        })
      );
    }

    await record({
      type: "space.created",
      organizationId: row.organizationId,
      spaceId: row.id,
      actorId: caller.principalId,
      entity: { type: "space", id: row.id },
      payload: { space: spaceView(row) },
      audit: { action: "CREATE", userId: caller.tereoUserId },
    });
    for (const member of members) {
      await record({
        type: "space.member_added",
        organizationId: row.organizationId,
        spaceId: row.id,
        actorId: caller.principalId,
        entity: { type: "space", id: row.id },
        payload: { spaceId: row.id, member: memberView(member) },
      });
    }
    return row;
  });

  res.status(201).json({ space: spaceView(space) });
};
