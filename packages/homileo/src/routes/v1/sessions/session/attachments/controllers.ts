import { ATTACHMENTS_BUCKET } from "../../../../../definitions/tereoDeclaration.js";
import { postRefusalError } from "../../../../../utils/postRefusals.js";
import { readableSession } from "../../../../../utils/access.js";
import { callerOf } from "../../../../../middleware/auth.js";
import { postRefusal } from "../../../../../policy/index.js";
import { CreateAttachmentBodySchema } from "./schemas.js";
import { logger } from "../../../../../utils/logger.js";
import { SessionParamsSchema } from "../schemas.js";
import type { Request, Response } from "express";
import { v7 as uuidv7 } from "uuid";
import {
  validateBody,
  validateParams,
} from "../../../../../utils/validateReq.js";
import {
  PLACEHOLDER_TTL_MS,
  UPLOAD_URL_SECONDS,
  filesClient,
  keyPrefix,
  tereoUnavailable,
} from "../../../../../utils/attachments.js";

/** An empty placeholder object and a presigned URL to fill it (tereo presigns only existing objects). */
export const createAttachment = async (req: Request, res: Response) => {
  const caller = callerOf(req);
  const { sessionId } = validateParams(SessionParamsSchema, req);
  const body = validateBody(CreateAttachmentBodySchema, req);

  const context = await readableSession(caller, sessionId);
  const refusal = postRefusal(caller, context.facts);
  if (refusal) throw postRefusalError[refusal]();

  const files = filesClient();
  const key = `${keyPrefix(sessionId, caller.principalId)}${uuidv7()}`;
  let placeholderId: string | null = null;
  try {
    const placeholder = await files.uploadObject(ATTACHMENTS_BUCKET, key, {
      file: Buffer.alloc(0),
      contentType: body.contentType,
      metadata: { filename: body.filename },
    });
    placeholderId = placeholder.id;
    // `uploadObject` takes no expiry, so it is set right after.
    await files.patchObject(ATTACHMENTS_BUCKET, placeholder.id, {
      deleteAfter: new Date(Date.now() + PLACEHOLDER_TTL_MS).toISOString(),
    });
    const upload = await files.presignObjectUrl(
      ATTACHMENTS_BUCKET,
      placeholder.id,
      { operation: "write", expiresInSeconds: UPLOAD_URL_SECONDS }
    );
    res.status(201).json({
      objectId: placeholder.id,
      uploadUrl: upload.url,
      expiresAt: upload.expiresAt,
    });
  } catch (err) {
    if (placeholderId) {
      const objectId = placeholderId;
      await files.deleteObject(ATTACHMENTS_BUCKET, objectId).catch((e) => {
        logger.warn({ err: e, objectId }, "Could not remove a placeholder");
      });
    }
    throw tereoUnavailable(err);
  }
};
