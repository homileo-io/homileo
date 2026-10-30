import { PAYLOAD_MAX_BYTES } from "../sessions/session/messages/schemas.js";
import { MESSAGE_BODY_MAX } from "../sessions/session/messages/schemas.js";
import { metadataSchema } from "../../../utils/metadata.js";
import { IdSchema } from "../../../utils/idSchema.js";
import { z } from "zod";

export const MessageParamsSchema = z.object({ messageId: IdSchema });

export const EditMessageBodySchema = z
  .strictObject({
    body: z.string().min(1).max(MESSAGE_BODY_MAX).optional(),
    payload: z
      .json()
      .refine((p) => p !== null, "A payload cannot be null")
      .refine(
        (p) => Buffer.byteLength(JSON.stringify(p)) <= PAYLOAD_MAX_BYTES,
        "At most 64 KiB serialized"
      )
      .optional(),
    metadata: metadataSchema.optional(),
  })
  .refine(
    (m) =>
      m.body !== undefined ||
      m.payload !== undefined ||
      m.metadata !== undefined,
    "Give at least one of body, payload and metadata"
  );

export type EditMessageBody = z.infer<typeof EditMessageBodySchema>;
