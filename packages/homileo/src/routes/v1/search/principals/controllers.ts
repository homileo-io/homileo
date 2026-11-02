import { validateQuery } from "../../../../utils/validateReq.js";
import { grantedKindsOf } from "../../../../utils/db/spaces.js";
import type { PrincipalSearchResult } from "@homileo-io/sdk";
import { SearchPrincipalsQuerySchema } from "./schemas.js";
import { principalView } from "../../../../views/index.js";
import { callerOf } from "../../../../middleware/auth.js";
import { db } from "../../../../utils/db/index.js";
import type { Request, Response } from "express";

export const searchPrincipals = async (req: Request, res: Response) => {
  const caller = callerOf(req);
  const { q, limit } = validateQuery(SearchPrincipalsQuerySchema, req);
  const rows = await db.search.principals({
    caller,
    granted: await grantedKindsOf(caller),
    q,
    limit,
  });
  const body: PrincipalSearchResult = { data: rows.map(principalView) };
  res.status(200).json(body);
};
