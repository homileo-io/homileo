import { ATTACHMENTS_BUCKET } from "../definitions/tereoDeclaration.js";
import { prisma } from "../utils/db/prisma.js";
import { logger } from "../utils/logger.js";
import env from "../env.js";
import {
  filesClient,
  isTereoNotFound,
  PLACEHOLDER_TTL_MS,
  UPLOAD_URL_SECONDS,
} from "../utils/attachments.js";

/**
 * Attachments younger than this are left to the send that is still keeping
 * them. It outlasts the placeholder's write URL, issued before the send, so
 * no new upload can start after the first check.
 */
export const KEEP_GRACE_MS = UPLOAD_URL_SECONDS * 1000 + 60 * 1000;

/**
 * A PUT that began before its write URL expired can still be writing when
 * the first pass looks, so a second pass checks the size again this long
 * after the send. An upload that runs longer still escapes both.
 */
export const RECHECK_AFTER_MS = 60 * 60 * 1000;
const BATCH = 100;
const PARALLEL = 10;

/** Below every UUIDv7 of millisecond `at`, so an id range is a time range on the primary key. */
const idAt = (at: Date): string => {
  const hex = at.getTime().toString(16).padStart(12, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-0000-0000-000000000000`;
};

/** The millisecond a UUIDv7 was made in. */
const timeOf = (id: string): Date =>
  new Date(parseInt(id.replace(/-/g, "").slice(0, 12), 16));

/**
 * Clears the object's expiry if it still has one, and removes an object the
 * write URL refilled past `ATTACHMENT_MAX_BYTES` after the send; `false` when
 * tereo could not be reached.
 */
const keep = async (a: {
  id: string;
  tereoObjectId: string;
}): Promise<boolean> => {
  const files = filesClient();
  try {
    const object = await files.getObject(ATTACHMENTS_BUCKET, a.tereoObjectId);
    if (!object) {
      logger.warn({ attachmentId: a.id }, "Attachment object is gone");
      return true;
    }
    if (BigInt(object.sizeBytes) > BigInt(env.ATTACHMENT_MAX_BYTES)) {
      await files.deleteObject(ATTACHMENTS_BUCKET, a.tereoObjectId);
      logger.warn(
        { attachmentId: a.id, sizeBytes: object.sizeBytes },
        "Removed an attachment larger than ATTACHMENT_MAX_BYTES"
      );
      return true;
    }
    if (object.deleteAfter !== null) {
      await files.patchObject(ATTACHMENTS_BUCKET, a.tereoObjectId, {
        deleteAfter: null,
      });
      logger.info({ attachmentId: a.id }, "Kept an expiring attachment");
    }
    return true;
  } catch (err) {
    if (isTereoNotFound(err)) {
      logger.warn({ attachmentId: a.id }, "Attachment object is gone");
      return true;
    }
    logger.warn({ err, attachmentId: a.id }, "Could not keep an attachment");
    return false;
  }
};

const keepRange = async (
  from: Date,
  now: Date,
  delayMs: number
): Promise<Date> => {
  const horizon = new Date(now.getTime() - PLACEHOLDER_TTL_MS);
  const start = from < horizon ? horizon : from;
  const end = new Date(now.getTime() - delayMs);
  // A cursor never moves back, or the range it skipped would be walked again.
  if (end <= start) return start;
  let after = idAt(start);
  let firstFailed: string | null = null;
  for (;;) {
    const rows = await prisma.$queryRaw<
      Array<{ id: string; tereoObjectId: string }>
    >`
      SELECT id::text, tereo_object_id AS "tereoObjectId"
      FROM "chat"."attachments"
      WHERE id > ${after}::uuid AND id < ${idAt(end)}::uuid
      ORDER BY id
      LIMIT ${BATCH}`;
    for (let i = 0; i < rows.length; i += PARALLEL) {
      const chunk = rows.slice(i, i + PARALLEL);
      const kept = await Promise.all(chunk.map(keep));
      // One object that keeps failing must not hold back the rest; the
      // next run starts again from it.
      firstFailed ??= chunk.find((_, j) => !kept[j])?.id ?? null;
    }
    if (rows.length < BATCH) return firstFailed ? timeOf(firstFailed) : end;
    after = rows[rows.length - 1].id;
  }
};

/** Where each pass of the next keep run starts. */
export interface KeepCursors {
  /** Attachments stored from here up to `KEEP_GRACE_MS` ago. */
  keep: Date;
  /** Attachments stored from here up to `RECHECK_AFTER_MS` ago. */
  recheck: Date;
}

export const START_OF_KEEPS: KeepCursors = {
  keep: new Date(0),
  recheck: new Date(0),
};

/**
 * Keeps (see `keep`) every attachment stored in either pass's range: a send
 * whose keep failed, or that stopped between commit and keep, and any object
 * refilled after its send. Each pass returns where its next run starts: the
 * first attachment it could not keep, or the end of its range.
 */
export const processAttachmentKeeps = async (
  from: KeepCursors,
  now = new Date()
): Promise<KeepCursors> => ({
  keep: await keepRange(from.keep, now, KEEP_GRACE_MS),
  recheck: await keepRange(from.recheck, now, RECHECK_AFTER_MS),
});
