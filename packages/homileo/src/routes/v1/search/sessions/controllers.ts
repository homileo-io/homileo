import type { SessionSearchHit, SessionSearchPage } from "@homileo-io/sdk";
import { sessionView, spaceView } from "../../../../views/index.js";
import { validateQuery } from "../../../../utils/validateReq.js";
import { grantedKindsOf } from "../../../../utils/db/spaces.js";
import { callerOf } from "../../../../middleware/auth.js";
import { SearchSessionsQuerySchema } from "./schemas.js";
import { prisma } from "../../../../utils/db/prisma.js";
import { db } from "../../../../utils/db/index.js";
import type { Request, Response } from "express";
import env from "../../../../env.js";
import {
  encodeSearchCursor,
  parseSearchCursor,
  parseSearchQuery,
} from "../../../../utils/search.js";

export const searchSessions = async (req: Request, res: Response) => {
  const caller = callerOf(req);
  const { q, cursor, limit, ...filters } = validateQuery(
    SearchSessionsQuerySchema,
    req
  );
  const { asOf, offset } = cursor
    ? parseSearchCursor(cursor, env.SEARCH_MAX_DEPTH)
    : { asOf: new Date(), offset: 0 };
  // The last page before the depth limit is cut short at it.
  const pageSize = Math.min(limit, env.SEARCH_MAX_DEPTH - offset);
  const rows = await db.search.sessions(caller, await grantedKindsOf(caller), {
    ...parseSearchQuery(q),
    ...filters,
    asOf,
    offset,
    limit: pageSize,
  });
  const hasMore = rows.length > pageSize;
  const page = rows.slice(0, pageSize);

  const [spaces, sessions] = await Promise.all([
    prisma.space.findMany({
      where: {
        id: { in: page.filter((r) => r.type === "space").map((r) => r.id) },
      },
    }),
    prisma.session.findMany({
      where: {
        id: { in: page.filter((r) => r.type === "session").map((r) => r.id) },
      },
    }),
  ]);
  const spaceById = new Map(spaces.map((r) => [r.id, r]));
  const sessionById = new Map(sessions.map((r) => [r.id, r]));
  // Keep the ranked order.
  const data = page.flatMap((r): SessionSearchHit[] => {
    if (r.type === "space") {
      const space = spaceById.get(r.id);
      return space ? [{ type: "space", space: spaceView(space) }] : [];
    }
    const session = sessionById.get(r.id);
    return session ? [{ type: "session", session: sessionView(session) }] : [];
  });

  const next = offset + pageSize;
  const body: SessionSearchPage = {
    data,
    nextCursor:
      hasMore && next < env.SEARCH_MAX_DEPTH
        ? encodeSearchCursor(asOf, next)
        : null,
  };
  res.status(200).json(body);
};
