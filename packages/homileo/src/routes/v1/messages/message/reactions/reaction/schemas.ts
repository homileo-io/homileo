import { IdSchema } from "../../../../../../utils/idSchema.js";
import { z } from "zod";

// The `v` flag is ES2024, past the compile target, so the pattern is built at run time.
const EMOJI = new RegExp("^\\p{RGI_Emoji}$", "v");
const SHORTCODE = /^:[a-z0-9_+-]{1,62}:$/;

/** One emoji sequence, or a `:shortcode:`; 64 characters at most (the column's width). */
export const EmojiSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((s) => SHORTCODE.test(s) || EMOJI.test(s), "Not an emoji");

export const ReactionParamsSchema = z.object({
  messageId: IdSchema,
  emoji: EmojiSchema,
});
