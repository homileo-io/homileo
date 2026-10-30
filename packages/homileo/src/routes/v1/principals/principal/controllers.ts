import { validateParams } from "../../../../utils/validateReq.js";
import { principalView } from "../../../../views/principal.js";
import { NotFoundError } from "../../../../utils/errors.js";
import { prisma } from "../../../../utils/db/prisma.js";
import { PrincipalParamsSchema } from "./schemas.js";
import type { Request, Response } from "express";

/** Principals belong to no organization, so any signed-in caller may read one. */
export const getPrincipal = async (req: Request, res: Response) => {
  const { principalId } = validateParams(PrincipalParamsSchema, req);
  const row = await prisma.principal.findUnique({ where: { id: principalId } });
  if (!row) throw new NotFoundError("Principal not found");
  res.status(200).json({ principal: principalView(row) });
};
