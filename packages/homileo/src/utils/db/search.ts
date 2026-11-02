import { readableSessionSql, readableSpaceSql } from "../../policy/sql.js";
import { Prisma } from "../../../prisma/generated/client/index.js";
import { metadataFilterSql, parseSearchQuery } from "../search.js";
import { HIGHLIGHT_START, HIGHLIGHT_STOP } from "../search.js";
import type { OrgCaller } from "../../middleware/auth.js";
import { prisma } from "./prisma.js";
import type {
  Message,
  Principal,
  Session,
} from "../../../prisma/generated/client/index.js";

export interface MessageSearch {
  /** For `websearch_to_tsquery`. */
  text: string;
  /** For the trigram arm, or null when it does not apply (`parseSearchQuery`). */
  trigramTerm: string | null;
  asOf: Date;
  offset: number;
  limit: number;
  sessionId?: string;
  spaceId?: string;
  kind?: string;
  senderId?: string;
  /** Inclusive. */
  from?: Date;
  /** Exclusive. */
  to?: Date;
  hasAttachment?: boolean;
  /** Replies (`true`) or not (`false`). */
  inThread?: boolean;
  /** Each matches the session's metadata or its space's. */
  metadata: Record<string, string>;
}

export interface MessageSearchResult {
  hits: MessageHit[];
  /** Whether a row follows the page. */
  hasMore: boolean;
}

export interface MessageHit {
  message: Message;
  session: Session;
  /** `ts_headline` with `HIGHLIGHT_START` / `HIGHLIGHT_STOP` around the matches. */
  headline: string;
}

const HEADLINE_OPTIONS = `StartSel=${HIGHLIGHT_START}, StopSel=${HIGHLIGHT_STOP}, MaxFragments=2, MaxWords=24, MinWords=8, FragmentDelimiter=" … "`;
const MARKERS = HIGHLIGHT_START + HIGHLIGHT_STOP;

const filtersOf = (q: MessageSearch): Prisma.Sql[] => [
  ...(q.sessionId ? [Prisma.sql`m.session_id = ${q.sessionId}::uuid`] : []),
  ...(q.spaceId ? [Prisma.sql`s.space_id = ${q.spaceId}::uuid`] : []),
  ...(q.kind ? [Prisma.sql`sp.kind = ${q.kind}`] : []),
  ...(q.senderId ? [Prisma.sql`m.sender_id = ${q.senderId}::uuid`] : []),
  ...(q.from ? [Prisma.sql`m.created_at >= ${q.from}::timestamp(3)`] : []),
  ...(q.to ? [Prisma.sql`m.created_at < ${q.to}::timestamp(3)`] : []),
  ...(q.hasAttachment === undefined
    ? []
    : [
        Prisma.sql`${Prisma.raw(q.hasAttachment ? "" : "NOT ")}EXISTS (SELECT 1 FROM "chat"."attachments" fa WHERE fa.message_id = m.id)`,
      ]),
  ...(q.inThread === undefined
    ? []
    : [
        Prisma.raw(
          q.inThread
            ? "m.thread_root_id IS NOT NULL"
            : "m.thread_root_id IS NULL"
        ),
      ]),
  ...Object.entries(q.metadata).map(
    ([key, value]) =>
      Prisma.sql`(${metadataFilterSql(Prisma.raw("s.metadata"), key, value)} OR ${metadataFilterSql(Prisma.raw("sp.metadata"), key, value)})`
  ),
];

/**
 * One page of the messages the caller can read that match, best first: by relevance to 2
 * decimals, then newest. Relevance is the full-text rank plus, when the trigram arm applies, the
 * term's word similarity to the body. A sum, not the greater of the two: a body naming the word at
 * all has a similarity near 1, which would hide how often it names it.
 *
 * `deleted_at`, not `body_text`, keeps deleted messages out: a message with attachments and no
 * text has no `body_text` either, and is still found by a file name.
 */
export const messages = async (
  caller: OrgCaller,
  grantedKinds: string[],
  q: MessageSearch
): Promise<MessageSearchResult> => {
  const term = q.trigramTerm;
  const trigramScore =
    term === null
      ? Prisma.sql`0`
      : Prisma.sql`COALESCE(chat.word_similarity(${term}, m.body_text), 0)`;
  const trigramMatch =
    term === null
      ? Prisma.empty
      : Prisma.sql`OR ${term} OPERATOR(chat.<%) m.body_text
          OR EXISTS (SELECT 1 FROM "chat"."attachments" a WHERE a.message_id = m.id AND ${term} OPERATOR(chat.<%) a.filename)`;
  const filters = filtersOf(q);

  const rows = await prisma.$queryRaw<Array<{ id: string; headline: string }>>`
    WITH hits AS (
      SELECT m.id, m.created_at,
             round((
               CASE WHEN m.search_vector @@ tsq THEN ts_rank_cd(m.search_vector, tsq, 32) ELSE 0 END
               + ${trigramScore}
             )::numeric, 2) AS relevance
      FROM "chat"."messages" m
      JOIN "chat"."sessions" s ON s.id = m.session_id
      LEFT JOIN "chat"."spaces" sp ON sp.id = s.space_id,
      websearch_to_tsquery('english', ${q.text}) tsq
      WHERE m.deleted_at IS NULL AND m.created_at <= ${q.asOf}::timestamp(3)
        AND ${readableSessionSql(caller, grantedKinds, "s")}
        AND (m.search_vector @@ tsq ${trigramMatch})
        ${filters.length > 0 ? Prisma.sql`AND ${Prisma.join(filters, " AND ")}` : Prisma.empty}
      ORDER BY relevance DESC, m.created_at DESC, m.id DESC
      OFFSET ${q.offset} LIMIT ${q.limit + 1}
    )
    SELECT h.id,
           COALESCE(ts_headline('english', translate(m.body_text, ${MARKERS}, ''), tsq, ${HEADLINE_OPTIONS}), '') AS headline
    FROM hits h
    JOIN "chat"."messages" m ON m.id = h.id,
    websearch_to_tsquery('english', ${q.text}) tsq
    ORDER BY h.relevance DESC, h.created_at DESC, h.id DESC`;
  const hasMore = rows.length > q.limit;
  const page = rows.slice(0, q.limit);
  if (page.length === 0) return { hits: [], hasMore };

  const found = await prisma.message.findMany({
    where: { id: { in: page.map((r) => r.id) } },
  });
  const byId = new Map(found.map((m) => [m.id, m]));
  const sessions = new Map(
    (
      await prisma.session.findMany({
        where: { id: { in: [...new Set(found.map((m) => m.sessionId))] } },
      })
    ).map((s) => [s.id, s])
  );
  // A message deleted between the two reads drops out.
  const hits = page.flatMap((r) => {
    const message = byId.get(r.id);
    const session = message && sessions.get(message.sessionId);
    if (!message || !session || message.deletedAt !== null) return [];
    return [{ message, session, headline: r.headline }];
  });
  return { hits, hasMore };
};

export interface SessionSearch {
  /** For `websearch_to_tsquery`. */
  text: string;
  /** For the trigram arm, or null when it does not apply (`parseSearchQuery`). */
  trigramTerm: string | null;
  asOf: Date;
  offset: number;
  limit: number;
  /** Only sessions of this space, and no spaces. */
  spaceId?: string;
  /** Spaces of this kind, and the sessions in them. */
  kind?: string;
  /** Each matches the row's own metadata. */
  metadata: Record<string, string>;
}

export interface SessionSearchRow {
  type: "space" | "session";
  id: string;
}

/**
 * One page of the spaces and sessions the caller can read that match, in one list, best first: by
 * relevance as in `messages`, then recency (a space's `created_at`, a session's last message or
 * `created_at`), then id. Returns up to `limit + 1` rows; the extra one says another page follows.
 */
export const sessions = async (
  caller: OrgCaller,
  grantedKinds: string[],
  q: SessionSearch
): Promise<SessionSearchRow[]> => {
  const term = q.trigramTerm;
  const arm = (alias: string, tsq: Prisma.Sql) => ({
    relevance:
      term === null
        ? Prisma.sql`round(ts_rank_cd(to_tsvector('english', ${Prisma.raw(alias)}.search_text), ${tsq}, 32)::numeric, 2)`
        : Prisma.sql`round((CASE WHEN to_tsvector('english', ${Prisma.raw(alias)}.search_text) @@ ${tsq} THEN ts_rank_cd(to_tsvector('english', ${Prisma.raw(alias)}.search_text), ${tsq}, 32) ELSE 0 END + COALESCE(chat.word_similarity(${term}, ${Prisma.raw(alias)}.search_text), 0))::numeric, 2)`,
    match:
      term === null
        ? Prisma.sql`to_tsvector('english', ${Prisma.raw(alias)}.search_text) @@ ${tsq}`
        : Prisma.sql`(to_tsvector('english', ${Prisma.raw(alias)}.search_text) @@ ${tsq} OR ${term} OPERATOR(chat.<%) ${Prisma.raw(alias)}.search_text)`,
  });
  const metadataOf = (column: string) =>
    Object.entries(q.metadata).map(([key, value]) =>
      metadataFilterSql(Prisma.raw(column), key, value)
    );
  const where = (conditions: Prisma.Sql[]) => Prisma.join(conditions, " AND ");
  const tsq = Prisma.sql`q.tsq`;
  const asOf = Prisma.sql`${q.asOf}::timestamp(3)`;

  const spaceArm = arm("sp", tsq);
  const spaceArmSql =
    q.spaceId !== undefined
      ? Prisma.empty
      : Prisma.sql`
        SELECT 'space'::text AS type, sp.id, ${spaceArm.relevance} AS relevance, sp.created_at AS recency
        FROM "chat"."spaces" sp, q
        WHERE ${where([
          Prisma.sql`sp.created_at <= ${asOf}`,
          readableSpaceSql(caller, grantedKinds, "sp"),
          spaceArm.match,
          ...(q.kind ? [Prisma.sql`sp.kind = ${q.kind}`] : []),
          ...metadataOf("sp.metadata"),
        ])}
        UNION ALL`;

  const sessionArm = arm("s", tsq);
  const sessionArmSql = Prisma.sql`
        SELECT 'session'::text AS type, s.id, ${sessionArm.relevance} AS relevance, COALESCE(s.last_message_at, s.created_at) AS recency
        FROM "chat"."sessions" s
        LEFT JOIN "chat"."spaces" ssp ON ssp.id = s.space_id, q
        WHERE ${where([
          Prisma.sql`s.created_at <= ${asOf}`,
          readableSessionSql(caller, grantedKinds, "s"),
          sessionArm.match,
          ...(q.spaceId ? [Prisma.sql`s.space_id = ${q.spaceId}::uuid`] : []),
          ...(q.kind ? [Prisma.sql`ssp.kind = ${q.kind}`] : []),
          ...metadataOf("s.metadata"),
        ])}`;

  return prisma.$queryRaw<SessionSearchRow[]>`
    WITH q AS (SELECT websearch_to_tsquery('english', ${q.text}) AS tsq),
    hits AS (${spaceArmSql}${sessionArmSql}
    )
    SELECT type, id FROM hits
    ORDER BY relevance DESC, recency DESC, id DESC
    OFFSET ${q.offset} LIMIT ${q.limit + 1}`;
};

export interface PrincipalSearch {
  caller: OrgCaller;
  granted: string[];
  q: string;
  limit: number;
}

const escapeLike = (s: string): string => s.replace(/[\\%_]/g, "\\$&");

/**
 * Principals whose display name matches `q`, best first: a name starting with it, then trigram
 * word similarity, then name. Only principals with a participation row, current or past, in a
 * session the caller can read: principals belong to no organization, so an open name search would
 * show other organizations' people.
 */
export const principals = async (
  client: PrincipalSearch
): Promise<Principal[]> => {
  const { caller, granted, q, limit } = client;
  const { trigramTerm } = parseSearchQuery(q);
  const escaped = escapeLike(q);
  const trigramMatch =
    trigramTerm === null
      ? Prisma.empty
      : Prisma.sql`OR ${trigramTerm} OPERATOR(chat.<%) p.display_name`;

  return prisma.$queryRaw<Principal[]>`
    SELECT p.id, p.kind, p.tereo_user_id AS "tereoUserId", p.is_bot AS "isBot",
           p.display_name AS "displayName", p.avatar_url AS "avatarUrl",
           p.created_at AS "createdAt", p.updated_at AS "updatedAt"
    FROM "chat"."principals" p
    WHERE (p.display_name ILIKE '%' || ${escaped}::text || '%' ESCAPE '\\' ${trigramMatch})
      AND EXISTS (
        SELECT 1 FROM "chat"."session_participants" sp
        JOIN "chat"."sessions" s ON s.id = sp.session_id
        WHERE sp.user_id = p.id AND ${readableSessionSql(caller, granted, "s")})
    ORDER BY (p.display_name ILIKE ${escaped}::text || '%' ESCAPE '\\') DESC,
             chat.word_similarity(${q}::text, p.display_name) DESC,
             p.display_name, p.id
    LIMIT ${limit}`;
};
