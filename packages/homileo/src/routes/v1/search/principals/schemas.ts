import { z } from "zod";

export const SearchPrincipalsQuerySchema = z.strictObject({
  q: z.string().trim().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(20).default(10),
});

export type SearchPrincipalsQuery = z.infer<typeof SearchPrincipalsQuerySchema>;
