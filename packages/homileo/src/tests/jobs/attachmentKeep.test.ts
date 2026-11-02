// @module-tag int
// @module-tag messages
// @module-tag job
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { setFilesClient } from "../../utils/attachments.js";
import { chatFixtures } from "../support/chatFixtures.js";
import { fakeFiles } from "../support/fakeFiles.js";
import { prisma } from "../../utils/db/prisma.js";
import env from "../../env.js";
import {
  KEEP_GRACE_MS,
  processAttachmentKeeps,
  RECHECK_AFTER_MS,
  type KeepCursors,
} from "../../jobs/attachmentKeep.js";
import {
  PLACEHOLDER_TTL_MS,
  UPLOAD_URL_SECONDS,
} from "../../utils/attachments.js";

const fixtures = chatFixtures();
const files = fakeFiles();

beforeEach(() => setFilesClient(files.client));
afterEach(() => {
  setFilesClient(null);
  files.reset();
});
afterAll(() => fixtures.cleanup());

/** An attachment row whose object still expires, as a send whose keep failed leaves it. */
const expiring = async (sizeBytes?: string) => {
  const message = await fixtures.message("text");
  const object = files.put(
    `sessions/${message.sessionId}/x/${message.id}`,
    sizeBytes
  );
  await prisma.attachment.create({
    data: {
      messageId: message.id,
      tereoObjectId: object.id,
      filename: "a.txt",
      contentType: "text/plain",
      size: 5n,
    },
  });
  return { object };
};

/** A clock past the grace period of everything made so far. */
const later = () => new Date(Date.now() + KEEP_GRACE_MS + 1000);
/** A clock past the recheck of everything made so far. */
const muchLater = () => new Date(Date.now() + RECHECK_AFTER_MS + 1000);

/** Both passes starting just before now. */
const fromNow = (): KeepCursors => {
  const at = new Date(Date.now() - 1);
  return { keep: at, recheck: at };
};

describe("processAttachmentKeeps", () => {
  it("clears the expiry of attachments that still have one, and returns the end of the range", async () => {
    const from = fromNow();
    const a = await expiring();
    const b = await expiring();
    const now = later();

    const next = await processAttachmentKeeps(from, now);

    expect(files.objects.get(a.object.id)!.deleteAfter).toBeNull();
    expect(files.objects.get(b.object.id)!.deleteAfter).toBeNull();
    expect(next).toEqual({
      keep: new Date(now.getTime() - KEEP_GRACE_MS),
      recheck: from.recheck,
    });
  });

  it("leaves attachments younger than the grace period to their send", async () => {
    const from = fromNow();
    const a = await expiring();

    await processAttachmentKeeps(from);

    expect(files.objects.get(a.object.id)!.deleteAfter).not.toBeNull();
  });

  it("stops at the first attachment tereo cannot be reached for and starts there next time", async () => {
    const from = fromNow();
    const a = await expiring();
    files.failing.add("getObject");

    const next = await processAttachmentKeeps(from, later());

    expect(next.keep.getTime()).toBeGreaterThanOrEqual(from.keep.getTime());
    expect(next.keep.getTime()).toBeLessThanOrEqual(Date.now());
    files.failing.clear();
    await processAttachmentKeeps(next, later());
    expect(files.objects.get(a.object.id)!.deleteAfter).toBeNull();
  });

  it("goes past an object tereo no longer has", async () => {
    const from = fromNow();
    const gone = await expiring();
    const kept = await expiring();
    files.expire(gone.object.id);

    await processAttachmentKeeps(from, later());

    expect(files.objects.get(kept.object.id)!.deleteAfter).toBeNull();
  });

  it("removes an object refilled past ATTACHMENT_MAX_BYTES after its send", async () => {
    const from = fromNow();
    const big = await expiring(String(env.ATTACHMENT_MAX_BYTES + 1));
    const fits = await expiring(String(env.ATTACHMENT_MAX_BYTES));

    await processAttachmentKeeps(from, later());

    expect(files.objects.has(big.object.id)).toBe(false);
    expect(files.objects.get(fits.object.id)!.deleteAfter).toBeNull();
  });

  it("waits until the placeholder's write URL has expired", () => {
    expect(KEEP_GRACE_MS).toBeGreaterThan(UPLOAD_URL_SECONDS * 1000);
  });

  it("checks the size again RECHECK_AFTER_MS after the send, for an upload that outlived its URL", async () => {
    const from = fromNow();
    const slow = await expiring();
    const next = await processAttachmentKeeps(from, later());
    expect(files.objects.get(slow.object.id)!.deleteAfter).toBeNull();
    expect(next.recheck).toEqual(from.recheck);

    files.objects.get(slow.object.id)!.sizeBytes = String(
      env.ATTACHMENT_MAX_BYTES + 1
    );
    const now = muchLater();
    const last = await processAttachmentKeeps(next, now);

    expect(files.objects.has(slow.object.id)).toBe(false);
    expect(last.recheck).toEqual(new Date(now.getTime() - RECHECK_AFTER_MS));
  });

  it("holds back only the pass that could not reach tereo", async () => {
    const from = fromNow();
    const a = await expiring();
    const kept = await processAttachmentKeeps(from, later());
    files.failing.add("getObject");

    const now = muchLater();
    const next = await processAttachmentKeeps(kept, now);

    expect(next.keep).toEqual(new Date(now.getTime() - KEEP_GRACE_MS));
    expect(next.recheck.getTime()).toBeLessThanOrEqual(Date.now());
    files.failing.clear();
    files.objects.get(a.object.id)!.sizeBytes = String(
      env.ATTACHMENT_MAX_BYTES + 1
    );
    await processAttachmentKeeps(next, now);
    expect(files.objects.has(a.object.id)).toBe(false);
  });

  it("rechecks no earlier than an hour after the send, while the attachment is in the look-back", () => {
    expect(RECHECK_AFTER_MS).toBeGreaterThanOrEqual(60 * 60 * 1000);
    expect(RECHECK_AFTER_MS).toBeLessThan(PLACEHOLDER_TTL_MS);
  });

  it("looks back no further than a placeholder lives", async () => {
    const a = await expiring();

    await processAttachmentKeeps(
      { keep: new Date(0), recheck: new Date(0) },
      new Date(Date.now() + PLACEHOLDER_TTL_MS + 1000)
    );

    expect(files.objects.get(a.object.id)!.deleteAfter).not.toBeNull();
  });
});
