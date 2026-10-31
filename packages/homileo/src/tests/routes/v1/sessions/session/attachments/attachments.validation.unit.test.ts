// @module-tag unit
// @module-tag sessions
import { CreateAttachmentBodySchema } from "../../../../../../routes/v1/sessions/session/attachments/schemas.js";
import { SendMessageBodySchema } from "../../../../../../routes/v1/sessions/session/messages/schemas.js";
import { describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";

describe("POST /v1/sessions/:sessionId/attachments body", () => {
  it.each([
    ["no filename", { contentType: "text/plain" }],
    ["an empty filename", { filename: "", contentType: "text/plain" }],
    ["a filename over 255", { filename: "a".repeat(256), contentType: "t/p" }],
    ["a slash in the filename", { filename: "a/b", contentType: "t/p" }],
    ["a control character", { filename: "a\nb", contentType: "t/p" }],
    ["no contentType", { filename: "a.txt" }],
    ["an empty contentType", { filename: "a.txt", contentType: "" }],
    ["an unknown key", { filename: "a", contentType: "t/p", x: 1 }],
  ])("rejects %s", (_name, body) => {
    expect(CreateAttachmentBodySchema.safeParse(body).success).toBe(false);
  });

  it("accepts a filename and content type", () => {
    expect(
      CreateAttachmentBodySchema.safeParse({
        filename: "report 1.pdf",
        contentType: "application/pdf",
      }).success
    ).toBe(true);
  });
});

describe("attachments in the send body", () => {
  const base = { clientMessageId: "c-1" };
  const ref = () => ({ objectId: uuidv7() });

  it.each([
    ["11 attachments", { attachments: Array.from({ length: 11 }, ref) }],
    ["a repeated objectId", { attachments: [ref(), { objectId: "X" }] }],
    ["a bad objectId", { attachments: [{ objectId: "nope" }] }],
    ["an unknown attachment key", { attachments: [{ ...ref(), size: 1 }] }],
    ["a slash in a filename", { attachments: [{ ...ref(), filename: "a/b" }] }],
    ["an empty text message", { attachments: [] }],
  ])("rejects %s", (_name, extra) => {
    expect(SendMessageBodySchema.safeParse({ ...base, ...extra }).success).toBe(
      false
    );
  });

  it("rejects the same objectId twice, in any case", () => {
    const id = uuidv7();
    const result = SendMessageBodySchema.safeParse({
      ...base,
      attachments: [{ objectId: id }, { objectId: id.toUpperCase() }],
    });
    expect(result.success).toBe(false);
  });

  it("takes a text message with attachments and no body, up to 10", () => {
    const result = SendMessageBodySchema.safeParse({
      ...base,
      attachments: Array.from({ length: 10 }, ref),
    });
    expect(result.success).toBe(true);
  });
});
