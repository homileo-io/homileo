import { AttachmentFilenameSchema } from "../messages/schemas.js";
import { z } from "zod";

export const CreateAttachmentBodySchema = z.strictObject({
  filename: AttachmentFilenameSchema,
  contentType: z.string().min(1).max(255),
});
