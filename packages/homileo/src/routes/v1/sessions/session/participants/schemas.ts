import { CursorDateSchema } from "../../../../../utils/cursor.js";
import { IdSchema } from "../../../../../utils/idSchema.js";
import { z } from "zod";

export const ListParticipantsQuerySchema = z.strictObject({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** `[joinedAt, principalId]`. */
export const ParticipantCursorSchema = z.tuple([CursorDateSchema, IdSchema]);
