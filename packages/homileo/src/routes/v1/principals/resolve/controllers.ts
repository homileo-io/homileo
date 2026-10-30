import { resolveOrCreateUsers } from "../../../../utils/db/principals.js";
import { validateBody } from "../../../../utils/validateReq.js";
import { principalView } from "../../../../views/principal.js";
import { ResolveBodySchema } from "./schemas.js";
import type { Request, Response } from "express";

export const resolvePrincipals = async (req: Request, res: Response) => {
  const { tereoUserIds } = validateBody(ResolveBodySchema, req);
  const { data, missing } = await resolveOrCreateUsers(tereoUserIds);
  res.status(200).json({ data: data.map(principalView), missing });
};
