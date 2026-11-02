import { IdSchema } from "../../../../utils/idSchema.js";
import { z } from "zod";
import {
  liftMetadataQuery,
  SearchMetadataQuerySchema,
} from "../../../../utils/search.js";

export const SearchSessionsQuerySchema = z.preprocess(
  liftMetadataQuery,
  z.strictObject({
    q: z.string().trim().min(1).max(200),
    /** Spaces of this kind, and the sessions in them. */
    kind: z.string().min(1).max(128).optional(),
    /** Only sessions of this space. */
    spaceId: IdSchema.optional(),
    metadata: SearchMetadataQuerySchema.default({}),
    /** The `nextCursor` of the previous page. */
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
);

export type SearchSessionsQuery = z.infer<typeof SearchSessionsQuerySchema>;
