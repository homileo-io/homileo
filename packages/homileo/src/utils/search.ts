import { CursorDateSchema, encodeCursor, parseCursor } from "./cursor.js";
import { Prisma } from "../../prisma/generated/client/index.js";
import { METADATA_KEY_PATTERN } from "./metadata.js";
import type { SearchSnippet } from "@homileo-io/sdk";
import { z } from "zod";

/** `ts_headline`'s StartSel and StopSel: private-use characters, removed from the text first. */
export const HIGHLIGHT_START = "";
export const HIGHLIGHT_STOP = "";

const TRIGRAM_MIN_LENGTH = 3;

const hasWebsearchSyntax = (q: string): boolean =>
  q.includes('"') || /(^|\s)-/.test(q) || / or /i.test(q);

/**
 * The text for `websearch_to_tsquery`, and the term for the trigram arm: only a query of at least
 * 3 characters without websearch syntax, so a phrase or an exclusion keeps its meaning.
 */
export const parseSearchQuery = (
  q: string
): { text: string; trigramTerm: string | null } => {
  const text = q.trim();
  const trigram =
    text.length >= TRIGRAM_MIN_LENGTH && !hasWebsearchSyntax(text);
  return { text, trigramTerm: trigram ? text : null };
};

/**
 * `ts_headline`'s output, its markers turned into `[start, end)` ranges in UTF-16 code units of
 * the text without them. A marker without its pair is dropped and makes no range.
 */
export const parseHeadline = (marked: string): SearchSnippet => {
  let text = "";
  let open: number | null = null;
  const highlights: [number, number][] = [];
  for (const part of marked.split(/([])/)) {
    if (part === HIGHLIGHT_START) {
      open = text.length;
    } else if (part === HIGHLIGHT_STOP) {
      if (open !== null && open < text.length) {
        highlights.push([open, text.length]);
      }
      open = null;
    } else {
      text += part;
    }
  }
  return { text, highlights };
};

export const encodeSearchCursor = (asOf: Date, offset: number): string =>
  encodeCursor([asOf.toISOString(), offset]);

/**
 * A search page's position: the time the walk started, and how many results came before. An
 * offset at or past `maxDepth` is refused, so a tampered cursor never asks for a deep scan.
 */
export const parseSearchCursor = (
  cursor: string,
  maxDepth: number
): { asOf: Date; offset: number } => {
  const [asOf, offset] = parseCursor(
    cursor,
    z.tuple([
      CursorDateSchema,
      z
        .number()
        .int()
        .min(0)
        .max(maxDepth - 1),
    ])
  );
  return { asOf: new Date(asOf), offset };
};

export const METADATA_FILTERS_MAX = 5;

const METADATA_QUERY_KEY = /^metadata\[([^\]]*)\]$/;

/**
 * Express's simple query parser keeps `metadata[orderNumber]=x` as the key
 * `"metadata[orderNumber]"`; this lifts such keys into `metadata: { orderNumber: "x" }`, for
 * `SearchMetadataQuerySchema` to check. Use it as a `z.preprocess` before the query's schema.
 */
export const liftMetadataQuery = (input: unknown): unknown => {
  if (typeof input !== "object" || input === null) return input;
  const rest: Record<string, unknown> = {};
  // No prototype: `metadata[__proto__]` becomes an own key, for validation to refuse.
  const metadata: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(input)) {
    const match = METADATA_QUERY_KEY.exec(key);
    if (match) metadata[match[1]] = value;
    else rest[key] = value;
  }
  return Object.keys(metadata).length > 0 ? { ...rest, metadata } : rest;
};

/** Exact metadata filters: at most 5 keys, each value 1–255 characters. */
export const SearchMetadataQuerySchema = z
  // Not `z.record` first: it assigns onto a plain object and so drops a `__proto__` key unseen.
  .custom<Record<string, unknown>>(
    (m) => typeof m === "object" && m !== null && !Array.isArray(m),
    { message: "Expected an object" }
  )
  .refine((m) => Object.keys(m).length <= METADATA_FILTERS_MAX, {
    message: `At most ${METADATA_FILTERS_MAX} metadata filters`,
    abort: true,
  })
  .refine((m) => Object.keys(m).every((k) => METADATA_KEY_PATTERN.test(k)), {
    message: "Invalid metadata key",
    abort: true,
  })
  .pipe(
    z.record(z.string().regex(METADATA_KEY_PATTERN), z.string().min(1).max(255))
  );

// A number as JSON spells it: `01234` and `1.50` are text, not the numbers 1234 and 1.5.
const NUMERIC = /^-?(0|[1-9]\d*)(\.\d*[1-9])?$/;

/**
 * `column` (jsonb) holds `key` with `value`: as a string, or as the number or boolean `value`
 * spells. Each form is its own `@>`, so a GIN index on `column` serves it.
 */
export const metadataFilterSql = (
  column: Prisma.Sql,
  key: string,
  value: string
): Prisma.Sql => {
  const candidates = [
    Prisma.sql`jsonb_build_object(${key}::text, ${value}::text)`,
    ...(NUMERIC.test(value)
      ? [Prisma.sql`jsonb_build_object(${key}::text, ${value}::numeric)`]
      : []),
    ...(value === "true" || value === "false"
      ? [Prisma.sql`jsonb_build_object(${key}::text, ${value}::boolean)`]
      : []),
  ];
  return Prisma.sql`(${Prisma.join(
    candidates.map((c) => Prisma.sql`${column} @> ${c}`),
    " OR "
  )})`;
};
