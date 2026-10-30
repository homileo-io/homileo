// @module-tag int
// @module-tag messages
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { chatFixtures } from "../support/chatFixtures.js";
import { fakeFiles } from "../support/fakeFiles.js";
import { prisma } from "../../utils/db/prisma.js";
import { v7 as uuidv7 } from "uuid";
import {
  attachMessageFiles,
  keepAttachments,
  resolveAttachments,
  setFilesClient,
} from "../../utils/attachments.js";

const fixtures = chatFixtures();
const files = fakeFiles();

afterEach(() => {
  setFilesClient(null);
  files.objects.clear();
});
afterAll(() => fixtures.cleanup());

const setup = async () => {
  setFilesClient(files.client);
  const message = await fixtures.message("text");
  return {
    sender: { id: message.senderId },
    session: { id: message.sessionId },
    message,
  };
};

describe("attachMessageFiles", () => {
  it("stores the object's size and type, and a filename from the key when none is given", async () => {
    const { sender, session, message } = await setup();
    const key = `sessions/${session.id}/${sender.id}/${uuidv7()}`;
    const object = files.put(key, "42");

    await prisma.$transaction(async (tx) =>
      attachMessageFiles(tx, {
        sessionId: session.id,
        senderId: sender.id,
        messageId: message.id,
        attachments: await resolveAttachments([{ objectId: object.id }]),
      })
    );

    const [row] = await prisma.attachment.findMany({
      where: { messageId: message.id },
    });
    expect(row).toMatchObject({
      tereoObjectId: object.id,
      filename: key.split("/").pop(),
      contentType: "text/plain",
      size: 42n,
      position: 0,
    });
  });

  it("writes nothing when one of several is refused", async () => {
    const { sender, session, message } = await setup();
    const good = files.put(`sessions/${session.id}/${sender.id}/a`);
    const bad = files.put(`sessions/${session.id}/someone-else/b`);

    await expect(
      prisma.$transaction(async (tx) =>
        attachMessageFiles(tx, {
          sessionId: session.id,
          senderId: sender.id,
          messageId: message.id,
          attachments: await resolveAttachments([
            { objectId: good.id },
            { objectId: bad.id },
          ]),
        })
      )
    ).rejects.toMatchObject({ code: "attachment_not_found" });
    expect(
      await prisma.attachment.count({ where: { messageId: message.id } })
    ).toBe(0);
  });
});

describe("the unique index on tereo_object_id", () => {
  it("turns a claim of an already-attached object into attachment_not_found", async () => {
    const { sender, session, message } = await setup();
    const object = files.put(`sessions/${session.id}/${sender.id}/a`);
    const resolved = await resolveAttachments([{ objectId: object.id }]);
    await prisma.attachment.create({
      data: {
        messageId: message.id,
        tereoObjectId: object.id,
        filename: "x",
        contentType: "t/p",
        size: 1n,
      },
    });

    // The pre-check sees it too; the index alone is what a race would hit.
    await expect(
      prisma.attachment.create({
        data: {
          messageId: message.id,
          tereoObjectId: object.id,
          filename: "y",
          contentType: "t/p",
          size: 1n,
        },
      })
    ).rejects.toThrow();
    await expect(
      prisma.$transaction((tx) =>
        attachMessageFiles(tx, {
          sessionId: session.id,
          senderId: sender.id,
          messageId: message.id,
          attachments: resolved,
        })
      )
    ).rejects.toMatchObject({ code: "attachment_not_found" });
  });
});

describe("keepAttachments", () => {
  it("clears each object's expiry and swallows a failure", async () => {
    setFilesClient(files.client);
    const a = files.put("k/a");
    const b = files.put("k/b");

    await keepAttachments([
      { objectId: uuidv7() },
      { objectId: a.id },
      { objectId: b.id },
    ]);

    expect(files.objects.get(a.id)!.deleteAfter).toBeNull();
    expect(files.objects.get(b.id)!.deleteAfter).toBeNull();
  });
});
