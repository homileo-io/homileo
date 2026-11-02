import { validateQuery } from "../../../../utils/validateReq.js";
import { grantedKindsOf } from "../../../../utils/db/spaces.js";
import { callerOf } from "../../../../middleware/auth.js";
import { SearchMessagesQuerySchema } from "./schemas.js";
import type { MessageSearchPage } from "@homileo-io/sdk";
import { sessionView } from "../../../../views/index.js";
import { prisma } from "../../../../utils/db/prisma.js";
import { db } from "../../../../utils/db/index.js";
import type { Request, Response } from "express";
import env from "../../../../env.js";
import {
  encodeSearchCursor,
  parseHeadline,
  parseSearchCursor,
  parseSearchQuery,
} from "../../../../utils/search.js";

export const searchMessages = async (req: Request, res: Response) => {
  const caller = callerOf(req);
  const { q, cursor, limit, ...filters } = validateQuery(
    SearchMessagesQuerySchema,
    req
  );
  const { asOf, offset } = cursor
    ? parseSearchCursor(cursor, env.SEARCH_MAX_DEPTH)
    : { asOf: new Date(), offset: 0 };
  // The last page before the depth limit is cut short at it.
  const pageSize = Math.min(limit, env.SEARCH_MAX_DEPTH - offset);
  const { hits, hasMore } = await db.search.messages(
    caller,
    await grantedKindsOf(caller),
    { ...parseSearchQuery(q), ...filters, asOf, offset, limit: pageSize }
  );
  const views = await db.messages.loadViews(
    prisma,
    hits.map((h) => h.message)
  );
  const next = offset + pageSize;
  const body: MessageSearchPage = {
    data: hits.map((h, i) => ({
      message: views[i],
      session: sessionView(h.session),
      snippet: parseHeadline(h.headline),
    })),
    nextCursor:
      hasMore && next < env.SEARCH_MAX_DEPTH
        ? encodeSearchCursor(asOf, next)
        : null,
  };
  res.status(200).json(body);
};
