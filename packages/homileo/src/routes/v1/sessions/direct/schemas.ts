import { z } from "zod";

export const DirectBodySchema = z.strictObject({ principalId: z.guid() });
