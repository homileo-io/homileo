import { IdSchema } from "../../../../utils/idSchema.js";
import { z } from "zod";
import {
  liftMetadataQuery,
  SearchMetadataQuerySchema,
} from "../../../../utils/search.js";

const flag = z.enum(["true", "false"]).transform((v) => v === "true");

const instant = z.iso.datetime({ offset: true }).transform((v) => new Date(v));

export const SearchMessagesQuerySchema = z.preprocess(
  liftMetadataQuery,
  z.strictObject({
    q: z.string().trim().min(1).max(200),
    spaceId: IdSchema.optional(),
    kind: z.string().min(1).max(128).optional(),
    sessionId: IdSchema.optional(),
    senderId: IdSchema.optional(),
    /** Inclusive, on `createdAt`. */
    from: instant.optional(),
    /** Exclusive, on `createdAt`. */
    to: instant.optional(),
    hasAttachment: flag.optional(),
    /** Replies only (`true`), or none (`false`). */
    inThread: flag.optional(),
    metadata: SearchMetadataQuerySchema.default({}),
    /** The `nextCursor` of the previous page. */
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
);

export type SearchMessagesQuery = z.infer<typeof SearchMessagesQuerySchema>;
