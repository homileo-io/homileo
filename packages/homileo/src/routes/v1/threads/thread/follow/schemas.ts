import { z } from "zod";

export const FollowBodySchema = z.strictObject({ following: z.boolean() });
