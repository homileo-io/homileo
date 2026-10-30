import { callerOf } from "../../../middleware/auth.js";
import { prisma } from "../../../utils/db/prisma.js";
import type { Request, Response } from "express";

export const getMe = async (req: Request, res: Response) => {
  const caller = callerOf(req);
  const principal = await prisma.principal.findUniqueOrThrow({
    where: { id: caller.principalId },
  });
  res.status(200).json({
    principal: {
      id: principal.id,
      kind: principal.kind,
      tereoUserId: principal.tereoUserId,
      isBot: principal.isBot,
      displayName: principal.displayName,
      avatarUrl: principal.avatarUrl,
    },
    organizationId: caller.organizationId,
    permissions: caller.permissions,
  });
};
