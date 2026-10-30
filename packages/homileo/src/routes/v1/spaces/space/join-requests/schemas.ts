import { z } from "zod";

export const ListJoinRequestsQuerySchema = z.strictObject({
  status: z.enum(["pending", "approved", "denied"]).default("pending"),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** A list cursor's values: `created_at` as an ISO string, then the request id. */
export const JoinRequestCursorSchema = z.tuple([z.iso.datetime(), z.guid()]);
