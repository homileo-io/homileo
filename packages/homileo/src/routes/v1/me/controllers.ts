import { callerOf, principalOf } from "../../../middleware/auth.js";
import type { Request, Response } from "express";

export const getMe = (req: Request, res: Response) => {
  const caller = callerOf(req);
  const principal = principalOf(req);
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
