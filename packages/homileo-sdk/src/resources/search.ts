import { PrincipalSchema } from "./principal.js";
import { MessageSchema } from "./message.js";
import { SessionSchema } from "./session.js";
import { SpaceSchema } from "./space.js";
import { z } from "zod";

/**
 * `highlights` are `[start, end)` character offsets into `text`, which is the matched excerpt
 * and not the whole body.
 */
export const SearchSnippetSchema = z.strictObject({
  text: z.string(),
  highlights: z.array(
    z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])
  ),
});

export const MessageSearchHitSchema = z.strictObject({
  message: MessageSchema,
  session: SessionSchema,
  snippet: SearchSnippetSchema,
});

export const SessionSearchHitSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("space"), space: SpaceSchema }),
  z.strictObject({ type: z.literal("session"), session: SessionSchema }),
]);

export const MessageSearchPageSchema = z.strictObject({
  data: z.array(MessageSearchHitSchema),
  nextCursor: z.string().nullable(),
});

export const SessionSearchPageSchema = z.strictObject({
  data: z.array(SessionSearchHitSchema),
  nextCursor: z.string().nullable(),
});

export const PrincipalSearchResultSchema = z.strictObject({
  data: z.array(PrincipalSchema),
});

export type SearchSnippet = z.infer<typeof SearchSnippetSchema>;
export type MessageSearchHit = z.infer<typeof MessageSearchHitSchema>;
export type SessionSearchHit = z.infer<typeof SessionSearchHitSchema>;
export type MessageSearchPage = z.infer<typeof MessageSearchPageSchema>;
export type SessionSearchPage = z.infer<typeof SessionSearchPageSchema>;
export type PrincipalSearchResult = z.infer<typeof PrincipalSearchResultSchema>;
