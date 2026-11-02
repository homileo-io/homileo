import { AttachmentFilenameSchema } from "../messages/schemas.js";
import { z } from "zod";

const TOKEN = "[A-Za-z0-9!#$&^_.+-]";
/** `type/subtype` (RFC 6838) with optional `; name=value` parameters. */
export const MIME_TYPE = new RegExp(
  `^[A-Za-z0-9]${TOKEN}{0,126}/[A-Za-z0-9]${TOKEN}{0,126}` +
    `(?:[ \\t]*;[ \\t]*${TOKEN}+=(?:${TOKEN}+|"[^"\\\\\\r\\n]*"))*$`
);

export const CreateAttachmentBodySchema = z.strictObject({
  filename: AttachmentFilenameSchema,
  contentType: z
    .string()
    .min(1)
    .max(255)
    .regex(MIME_TYPE, "A media type such as image/png"),
});
