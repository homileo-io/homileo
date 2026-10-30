import { BUILTIN_MESSAGE_TYPE } from "../../../../../definitions/builtins.js";
import { metadataSchema } from "../../../../../utils/metadata.js";
import { IdSchema } from "../../../../../utils/idSchema.js";
import { z } from "zod";

export const MESSAGE_BODY_MAX = 40_000;
export const PAYLOAD_MAX_BYTES = 64 * 1024;

export const MAX_ATTACHMENTS = 10;

export const AttachmentFilenameSchema = z
  .string()
  .min(1)
  .max(255)
  // eslint-disable-next-line no-control-regex
  .regex(/^[^/\x00-\x1f\x7f]+$/, "No slash or control characters");

export const SendMessageBodySchema = z
  .strictObject({
    clientMessageId: z.string().min(1).max(128),
    type: z.string().min(1).max(64).default(BUILTIN_MESSAGE_TYPE),
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
    threadRootId: IdSchema.optional(),
    attachments: z
      .array(
        z.strictObject({
          objectId: IdSchema,
          filename: AttachmentFilenameSchema.optional(),
        })
      )
      .max(MAX_ATTACHMENTS)
      .refine(
        (a) => new Set(a.map((x) => x.objectId)).size === a.length,
        "objectIds must be unique"
      )
      .optional(),
  })
  .superRefine((m, ctx) => {
    if (m.type === BUILTIN_MESSAGE_TYPE) {
      if (m.body === undefined && !m.attachments?.length) {
        ctx.addIssue({
          code: "custom",
          path: ["body"],
          message: "A text message needs a body or attachments",
        });
      }
      if (m.payload !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["payload"],
          message: "A text message takes no payload",
        });
      }
    } else if (m.payload === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["payload"],
        message: "A message of a provisioned type needs a payload",
      });
    }
  });

export type SendMessageBody = z.infer<typeof SendMessageBodySchema>;

const seqParam = z
  .string()
  .regex(/^\d{1,15}$/, "A non-negative integer")
  .transform(Number);

export const ListMessagesQuerySchema = z
  .strictObject({
    before: seqParam.optional(),
    after: seqParam.optional(),
    around: seqParam.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .refine(
    (q) =>
      [q.before, q.after, q.around].filter((v) => v !== undefined).length <= 1,
    "Give at most one of before, after and around"
  );

export type ListMessagesQuery = z.infer<typeof ListMessagesQuerySchema>;
