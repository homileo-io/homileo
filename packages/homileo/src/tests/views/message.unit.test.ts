// @module-tag unit
// @module-tag messages
import { messageView, revisionView } from "../../views/index.js";
import { at, id, messageRow } from "../support/pure/viewRows.js";
import { describe, expect, it } from "vitest";
import {
  AttachmentSchema,
  MessageRevisionSchema,
  MessageSchema,
} from "@homileo-io/sdk";

describe("message views", () => {
  it("messageView turns bigint seq into a number and dates into ISO strings", () => {
    const view = messageView(messageRow);
    expect(MessageSchema.safeParse(view).success).toBe(true);
    expect(view.seq).toBe(12);
    expect(view.createdAt).toBe("2026-10-30T12:00:00.000Z");
    expect(view.attachments[0].size).toBe(2048);
    expect(AttachmentSchema.safeParse(view.attachments[0]).success).toBe(true);
    expect(view.attachments[0]).not.toHaveProperty("tereoObjectId");
    expect(view).not.toHaveProperty("bodyText");
  });

  it("messageView hides attachments and reactions of a deleted message", () => {
    const view = messageView({
      ...messageRow,
      deletedAt: at,
      deletedBy: id(1),
    });
    expect(MessageSchema.safeParse(view).success).toBe(true);
    expect(view.attachments).toEqual([]);
    expect(view.reactions).toEqual([]);
    expect(view.deletedAt).toBe("2026-10-30T12:00:00.000Z");
  });

  it("revisionView output parses with its SDK schema", () => {
    const view = revisionView({
      messageId: id(8),
      revision: 1,
      body: "hi",
      payload: { a: 1 },
      editedBy: id(1),
      editedAt: at,
    });
    expect(MessageRevisionSchema.safeParse(view).success).toBe(true);
    expect(view.editedAt).toBe("2026-10-30T12:00:00.000Z");
  });
});
