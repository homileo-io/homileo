import { ATTACHMENTS_BUCKET } from "../definitions/tereoDeclaration.js";
import { prisma } from "../utils/db/prisma.js";
import { logger } from "../utils/logger.js";
import {
  filesClient,
  isTereoNotFound,
  PLACEHOLDER_TTL_MS,
} from "../utils/attachments.js";

/** Attachments younger than this are left to the send that is still keeping them. */
export const KEEP_GRACE_MS = 5 * 60 * 1000;
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

/** Clears the object's expiry if it still has one; `false` when tereo could not be reached. */
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

/**
 * Clears the tereo expiry of every attachment stored from `from` up to
 * `KEEP_GRACE_MS` ago that still has one: a send whose keep failed, or that
 * stopped between commit and keep. Returns where the next run starts: the
 * first attachment tereo could not be reached for, or the end of this range.
 */
export const processAttachmentKeeps = async (
  from: Date,
  now = new Date()
): Promise<Date> => {
  const horizon = new Date(now.getTime() - PLACEHOLDER_TTL_MS);
  const start = from < horizon ? horizon : from;
  const end = new Date(now.getTime() - KEEP_GRACE_MS);
  let after = idAt(start);
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
      const failed = chunk.find((_, j) => !kept[j]);
      if (failed) return timeOf(failed.id);
    }
    if (rows.length < BATCH) return end;
    after = rows[rows.length - 1].id;
  }
};
