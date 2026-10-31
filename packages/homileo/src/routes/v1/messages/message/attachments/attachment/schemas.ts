import { IdSchema } from "../../../../../../utils/idSchema.js";
import { MessageParamsSchema } from "../../../schemas.js";

export const AttachmentParamsSchema = MessageParamsSchema.extend({
  attachmentId: IdSchema,
});
