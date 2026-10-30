import { z } from "zod";

export const PrincipalParamsSchema = z.object({ principalId: z.guid() });
