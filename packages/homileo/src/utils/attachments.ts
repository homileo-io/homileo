import { ATTACHMENTS_BUCKET } from "../definitions/tereoDeclaration.js";
import type { FileServiceObject } from "@tereo-io/sdk";
import type { CoreClient } from "@tereo-io/sdk";
import { BadRequestError } from "./errors.js";
import type { Prisma } from "./db/prisma.js";
import { getTereo } from "./tereo.js";
import { logger } from "./logger.js";

export type FilesClient = Pick<
  CoreClient["files"],
  | "uploadObject"
  | "presignObjectUrl"
  | "getObject"
  | "patchObject"
  | "deleteObject"
>;

let override: FilesClient | null = null;

/** Swaps the files client for tests; `null` restores tereo's. */
export const setFilesClient = (client: FilesClient | null): void => {
  override = client;
};

export const filesClient = (): FilesClient => override ?? getTereo().files;

export const UPLOAD_URL_SECONDS = 900;
export const READ_URL_SECONDS = 300;
/** How long a placeholder lives if no message claims it. */
export const PLACEHOLDER_TTL_MS = 24 * 60 * 60 * 1000;

export const keyPrefix = (sessionId: string, senderId: string): string =>
  `sessions/${sessionId}/${senderId}/`;

export interface AttachmentRef {
  objectId: string;
  filename?: string;
}

/** An attachment as named in the request, with the tereo object it names (`null` if tereo has none). */
export interface ResolvedAttachment extends AttachmentRef {
  object: FileServiceObject | null;
}

/** The tereo objects the request names; done before the transaction, so the session lock is not held over the calls. */
export const resolveAttachments = (
  attachments: AttachmentRef[]
): Promise<ResolvedAttachment[]> =>
  Promise.all(
    attachments.map(async (a) => ({
      ...a,
      object: await filesClient().getObject(ATTACHMENTS_BUCKET, a.objectId),
    }))
  );

const notFound = () =>
  new BadRequestError(
    "attachment_not_found",
    "An attachment was not found, or was not uploaded for this session by this sender"
  );

/**
 * Inserts the message's attachment rows. Each object must live under this
 * session and sender's key prefix, be uploaded, and not be on another message.
 */
export const attachMessageFiles = async (
  tx: Prisma.TransactionClient,
  input: {
    sessionId: string;
    senderId: string;
    messageId: string;
    attachments: ResolvedAttachment[];
  }
): Promise<void> => {
  const { attachments } = input;
  if (attachments.length === 0) return;
  const prefix = keyPrefix(input.sessionId, input.senderId);

  const taken = new Set(
    (
      await tx.attachment.findMany({
        where: { tereoObjectId: { in: attachments.map((a) => a.objectId) } },
        select: { tereoObjectId: true },
      })
    ).map((a) => a.tereoObjectId)
  );

  const rows = attachments.map((a, position) => {
    const { object } = a;
    if (!object || !object.key.startsWith(prefix) || taken.has(a.objectId)) {
      throw notFound();
    }
    if (object.sizeBytes === "0") {
      throw new BadRequestError(
        "attachment_not_uploaded",
        "An attachment has no content yet; upload it before sending"
      );
    }
    const named = object.metadata?.filename;
    return {
      messageId: input.messageId,
      tereoObjectId: a.objectId,
      filename:
        a.filename ??
        (typeof named === "string" ? named : object.key.split("/").pop()!),
      contentType: object.contentType,
      size: BigInt(object.sizeBytes),
      position,
    };
  });
  await tx.attachment.createMany({ data: rows });
};

/** Clears the placeholders' expiry once the message is committed; a failure leaves the object to expire. */
export const keepAttachments = async (
  attachments: AttachmentRef[]
): Promise<void> => {
  await Promise.all(
    attachments.map(async ({ objectId }) => {
      try {
        await filesClient().patchObject(ATTACHMENTS_BUCKET, objectId, {
          deleteAfter: null,
        });
      } catch (err) {
        logger.warn({ err, objectId }, "Could not keep an attachment object");
      }
    })
  );
};
