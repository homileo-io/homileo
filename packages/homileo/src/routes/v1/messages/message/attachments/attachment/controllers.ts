import { ATTACHMENTS_BUCKET } from "../../../../../../definitions/tereoDeclaration.js";
import { validateParams } from "../../../../../../utils/validateReq.js";
import { readableMessage } from "../../../../../../utils/access.js";
import { NotFoundError } from "../../../../../../utils/errors.js";
import { messageView } from "../../../../../../views/message.js";
import { callerOf } from "../../../../../../middleware/auth.js";
import { prisma } from "../../../../../../utils/db/index.js";
import { AttachmentParamsSchema } from "./schemas.js";
import type { Request, Response } from "express";
import {
  READ_URL_SECONDS,
  filesClient,
  isTereoNotFound,
  tereoUnavailable,
} from "../../../../../../utils/attachments.js";

const notFound = () => new NotFoundError("Attachment not found");

export const getAttachment = async (req: Request, res: Response) => {
  const caller = callerOf(req);
  const { messageId, attachmentId } = validateParams(
    AttachmentParamsSchema,
    req
  );
  const { message } = await readableMessage(caller, messageId);
  if (message.deletedAt !== null) throw notFound();

  const row = await prisma.attachment.findFirst({
    where: { id: attachmentId, messageId },
  });
  if (!row) throw notFound();

  let presigned;
  try {
    presigned = await filesClient().presignObjectUrl(
      ATTACHMENTS_BUCKET,
      row.tereoObjectId,
      { operation: "read", expiresInSeconds: READ_URL_SECONDS }
    );
  } catch (err) {
    // The object expired or was removed in tereo.
    if (isTereoNotFound(err)) throw notFound();
    throw tereoUnavailable(err);
  }
  const { attachments } = messageView({
    ...message,
    attachments: [row],
    reactions: [],
  });
  res.status(200).json({
    attachment: attachments[0],
    url: presigned.url,
    expiresAt: presigned.expiresAt,
  });
};
