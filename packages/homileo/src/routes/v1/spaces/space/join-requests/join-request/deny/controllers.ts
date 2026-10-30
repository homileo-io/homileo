import { decideJoinRequest } from "../../../../../../../utils/joinRequests.js";
import { validateParams } from "../../../../../../../utils/validateReq.js";
import { callerOf } from "../../../../../../../middleware/auth.js";
import { JoinRequestParamsSchema } from "../schemas.js";
import type { Request, Response } from "express";

export const denyJoinRequest = async (req: Request, res: Response) => {
  const { spaceId, principalId } = validateParams(JoinRequestParamsSchema, req);
  const request = await decideJoinRequest(
    callerOf(req),
    spaceId,
    principalId,
    "denied"
  );
  res.status(200).json({ request });
};
