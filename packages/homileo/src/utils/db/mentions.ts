import { Prisma as PrismaSql } from "../../../prisma/generated/client/index.js";
import type { Prisma, prisma } from "./prisma.js";

type Tx = Prisma.TransactionClient;
type Client = Tx | typeof prisma;

export interface MentionListParams {
  organizationId: string;
  userId: string;
  /** Message id below which to read, or null for the newest. */
  before: string | null;
  limit: number;
}

// Two sources, each filtered like the final page, ordered by message id and
// cut to `limit` (filtering after the cut would shorten pages and lose the cursor):
// the caller's own mentions, and for each current participation the broadcast
// mentions (here/session), read through `message_mentions_session_broadcast_idx`.
const listQuery = (p: MentionListParams) => PrismaSql.sql`
  SELECT m.id::text AS id
  FROM (
    (
      SELECT mm.message_id
      FROM "chat"."message_mentions" mm
      JOIN "chat"."messages" m ON m.id = mm.message_id
      JOIN "chat"."sessions" s ON s.id = m.session_id
      WHERE mm.user_id = ${p.userId}::uuid
        AND (${p.before}::uuid IS NULL OR mm.message_id < ${p.before}::uuid)
        AND m.deleted_at IS NULL
        AND m.sender_id <> ${p.userId}::uuid
        AND s.organization_id = ${p.organizationId}::uuid
      ORDER BY mm.message_id DESC
      LIMIT ${p.limit}
    )
    UNION
    (
      SELECT b.message_id
      FROM "chat"."session_participants" sp
      CROSS JOIN LATERAL (
        SELECT mm.message_id
        FROM "chat"."message_mentions" mm
        JOIN "chat"."messages" m ON m.id = mm.message_id
        JOIN "chat"."sessions" s ON s.id = m.session_id
        WHERE mm.session_id = sp.session_id
          AND mm.kind IN ('here', 'session')
          AND (${p.before}::uuid IS NULL OR mm.message_id < ${p.before}::uuid)
          AND m.deleted_at IS NULL
          AND m.sender_id <> ${p.userId}::uuid
          AND s.organization_id = ${p.organizationId}::uuid
        ORDER BY mm.message_id DESC
        LIMIT ${p.limit}
      ) b
      WHERE sp.user_id = ${p.userId}::uuid
        AND sp.left_at IS NULL
    )
  ) u
  JOIN "chat"."messages" m ON m.id = u.message_id
  JOIN "chat"."sessions" s ON s.id = m.session_id
  WHERE s.organization_id = ${p.organizationId}::uuid
    AND m.deleted_at IS NULL
    AND m.sender_id <> ${p.userId}::uuid
  ORDER BY m.id DESC
  LIMIT ${p.limit}`;

/** Ids of the caller's mentions, newest first; the caller passes `limit + 1` to detect a next page. */
export const listIds = async (
  client: Client,
  p: MentionListParams
): Promise<string[]> => {
  const rows = await client.$queryRaw<Array<{ id: string }>>(listQuery(p));
  return rows.map((r) => r.id);
};

/** The planner's JSON plan for `listIds`. */
export const explainList = async (
  client: Client,
  p: MentionListParams
): Promise<unknown> => {
  const rows = await client.$queryRaw<Array<Record<string, unknown>>>(
    PrismaSql.sql`EXPLAIN (FORMAT JSON) ${listQuery(p)}`
  );
  return rows[0]["QUERY PLAN"];
};
