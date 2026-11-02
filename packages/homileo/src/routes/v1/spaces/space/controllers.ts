import { validateBody, validateParams } from "../../../../utils/validateReq.js";
import { searchKeysFor, searchTextOf } from "../../../../utils/searchText.js";
import { ArchivedError, ForbiddenError } from "../../../../utils/errors.js";
import { mapUniqueViolation } from "../../../../utils/prismaErrors.js";
import { SpaceParamsSchema, UpdateSpaceSchema } from "./schemas.js";
import { canModerateSpace } from "../../../../policy/index.js";
import { withChanges } from "../../../../utils/transaction.js";
import type { Prisma } from "../../../../utils/db/prisma.js";
import { readableSpace } from "../../../../utils/access.js";
import { callerOf } from "../../../../middleware/auth.js";
import { spaceView } from "../../../../views/space.js";
import type { Request, Response } from "express";
import { isDeepStrictEqual } from "node:util";
import {
  assertOverridable,
  assertState,
} from "../../../../utils/spaceSettings.js";

export const getSpace = async (req: Request, res: Response) => {
  const { spaceId } = validateParams(SpaceParamsSchema, req);
  const { space, facts } = await readableSpace(callerOf(req), spaceId);
  res.status(200).json({ space: spaceView(space), role: facts.role });
};

export const updateSpace = async (req: Request, res: Response) => {
  const caller = callerOf(req);
  const { spaceId } = validateParams(SpaceParamsSchema, req);
  const body = validateBody(UpdateSpaceSchema, req);

  const space = await withChanges(async (tx, record) => {
    const { space: current, facts } = await readableSpace(caller, spaceId, {
      tx,
      lock: true,
    });
    if (facts.archived) throw new ArchivedError("The space is archived");
    if (!canModerateSpace(caller, facts)) {
      throw new ForbiddenError("Only a moderator can change a space");
    }
    assertOverridable(facts.kind, body);
    assertState(facts.kind, body.state);

    // A repeat that changes nothing writes and records nothing.
    const changed = (Object.keys(body) as Array<keyof typeof body>).filter(
      (field) => !isDeepStrictEqual(body[field], current[field])
    );
    if (changed.length === 0) return current;

    const searchText =
      changed.includes("name") || changed.includes("metadata")
        ? searchTextOf(
            body.name ?? current.name,
            (body.metadata ?? current.metadata) as Record<string, unknown>,
            await searchKeysFor(tx, current.kind)
          )
        : undefined;

    const row = await mapUniqueViolation(
      () =>
        tx.space.update({
          where: { id: current.id },
          data: {
            ...body,
            metadata: body.metadata as Prisma.InputJsonObject | undefined,
            searchText,
          },
        }),
      "A space of this kind with this externalRef already exists",
      "external_ref_taken"
    );
    await record({
      type: "space.updated",
      organizationId: row.organizationId,
      spaceId: row.id,
      actorId: caller.principalId,
      entity: { type: "space", id: row.id },
      payload: {
        space: spaceView(row),
        previousVisibility: current.visibility,
      },
      audit: {
        action: "UPDATE",
        userId: caller.tereoUserId,
        metadata: { fields: changed },
      },
    });
    return row;
  });

  res.status(200).json({ space: spaceView(space) });
};
