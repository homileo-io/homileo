import { assertNoTransaction, getTereo, guardTereoCalls } from "./tereo.js";
import { getOriginalStatus, type FileServiceObject } from "@tereo-io/sdk";
import { ATTACHMENTS_BUCKET } from "../definitions/tereoDeclaration.js";
import { isUniqueConstraintError } from "./prismaErrors.js";
import type { CoreClient } from "@tereo-io/sdk";
import type { Prisma } from "./db/prisma.js";
import { logger } from "./logger.js";
import { redis } from "./redis.js";
import env from "../env.js";
import {
  BadRequestError,
  ConflictError,
  ServiceUnavailableError,
} from "./errors.js";

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

export const filesClient = (): FilesClient =>
  override ? guardTereoCalls("files", override) : getTereo().files;

/** True when tereo answered 404 (`RequestError.statusCode` is the app-facing status; core's is `httpStatus`). */
export const isTereoNotFound = (err: unknown): boolean =>
  getOriginalStatus(err) === 404;

/** A tereo failure the caller can retry: 503, the cause logged. */
export const tereoUnavailable = (err: unknown): ServiceUnavailableError => {
  logger.error({ err }, "tereo files call failed");
  return new ServiceUnavailableError("File storage is temporarily unavailable");
};

export const UPLOAD_URL_SECONDS = 900;
export const READ_URL_SECONDS = 300;
/** How long a placeholder lives if no message claims it. */
export const PLACEHOLDER_TTL_MS = 24 * 60 * 60 * 1000;

export const keyPrefix = (sessionId: string, senderId: string): string =>
  `sessions/${sessionId}/${senderId}/`;

const pendingKey = (principalId: string) =>
  `${env.SERVICE_NAME}:attachments:pending:${principalId}`;

// Drops the expired placeholders, then adds this one unless the principal holds the most.
const RESERVE = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[2]) then return 0 end
redis.call('ZADD', KEYS[1], ARGV[3], ARGV[4])
redis.call('PEXPIREAT', KEYS[1], ARGV[3])
return 1`;

/**
 * Counts a new placeholder (by object key) against the principal's
 * `ATTACHMENT_MAX_PENDING` until a message claims it or it expires. Throws
 * `409 too_many_pending_attachments` at the cap, `503` without Redis.
 */
export const reservePlaceholder = async (
  principalId: string,
  objectKey: string,
  now: number = Date.now()
): Promise<void> => {
  // Not ready, a command would wait in the offline queue for as long as Redis is down.
  if (redis.status !== "ready") {
    throw new ServiceUnavailableError(
      "Attachments are temporarily unavailable"
    );
  }
  let reserved: unknown;
  try {
    reserved = await redis.eval(
      RESERVE,
      1,
      pendingKey(principalId),
      now,
      env.ATTACHMENT_MAX_PENDING,
      now + PLACEHOLDER_TTL_MS,
      objectKey
    );
  } catch (err) {
    logger.error({ err }, "Could not count a pending attachment");
    throw new ServiceUnavailableError(
      "Attachments are temporarily unavailable"
    );
  }
  if (reserved !== 1) {
    throw new ConflictError(
      `At most ${env.ATTACHMENT_MAX_PENDING} attachments may wait to be sent; send or let some expire first`,
      "too_many_pending_attachments"
    );
  }
};

/** Stops counting placeholders a message claimed, or that were never made; a failure leaves them to expire. */
export const releasePlaceholders = async (
  principalId: string,
  objectKeys: string[]
): Promise<void> => {
  if (objectKeys.length === 0 || redis.status !== "ready") return;
  try {
    await redis.zrem(pendingKey(principalId), ...objectKeys);
  } catch (err) {
    logger.warn({ err }, "Could not release pending attachments");
  }
};

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
    attachments.map(async (a) => {
      try {
        return {
          ...a,
          object: await filesClient().getObject(ATTACHMENTS_BUCKET, a.objectId),
        };
      } catch (err) {
        if (isTereoNotFound(err)) return { ...a, object: null };
        throw tereoUnavailable(err);
      }
    })
  );

const notFound = () =>
  new BadRequestError(
    "attachment_not_found",
    "An attachment was not found, or was not uploaded for this session by this sender"
  );

/**
 * Inserts the message's attachment rows. Each object must live under this
 * session and sender's key prefix, be uploaded, be at most
 * `ATTACHMENT_MAX_BYTES`, and not be on another message.
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
    if (BigInt(object.sizeBytes) > BigInt(env.ATTACHMENT_MAX_BYTES)) {
      throw new BadRequestError(
        "attachment_too_large",
        `An attachment is larger than ${env.ATTACHMENT_MAX_BYTES} bytes`
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
  try {
    await tx.attachment.createMany({ data: rows });
  } catch (err) {
    // A concurrent send claimed the same object; the unique index is the backstop.
    if (isUniqueConstraintError(err)) throw notFound();
    throw err;
  }
};

/**
 * Clears the placeholders' expiry once the message is committed. A failure is
 * left to a repeat of the send or to the worker's keep run (`jobs/attachmentKeep.ts`).
 */
export const keepAttachments = async (
  attachments: AttachmentRef[]
): Promise<void> => {
  // Outside the try below, which would swallow it.
  assertNoTransaction("keepAttachments");
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
