// @module-tag int
// @module-tag messages
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { setFilesClient } from "../../../../../../../utils/attachments.js";
import { chatFixtures } from "../../../../../../support/chatFixtures.js";
import { fakeFiles } from "../../../../../../support/fakeFiles.js";
import { startV1App } from "../../../../../../support/v1App.js";
import { fetchJson } from "../../../../../../support/http.js";
import { v7 as uuidv7 } from "uuid";
import {
  deleteMessage,
  sendMessage,
} from "../../../../../../support/messageApi.js";
import {
  purgeOrganizations,
  signIn,
} from "../../../../../../support/signedIn.js";

const fixtures = chatFixtures();
const orgs: string[] = [];
const files = fakeFiles();
let url: string;
let close: () => Promise<unknown>;

beforeAll(async () => {
  ({ url, close } = await startV1App());
  setFilesClient(files.client);
});
afterEach(() => {
  files.objects.clear();
  files.presigned.length = 0;
});
afterAll(async () => {
  setFilesClient(null);
  await close();
  await fixtures.cleanup();
  await purgeOrganizations(orgs);
});

/** A session with a sender and a message carrying one uploaded file. */
const withAttachment = async () => {
  const org = uuidv7();
  orgs.push(org);
  const me = await signIn(org);
  const session = await fixtures.session({ org });
  await fixtures.participant(session, { id: me.principalId }, "owner");
  const upload = await fetchJson(
    "POST",
    `${url}/v1/sessions/${session.id}/attachments`,
    me.token,
    { filename: "a.txt", contentType: "text/plain" }
  );
  files.setSize(upload.body.objectId, 7);
  const sent = await sendMessage(
    session.id,
    me.token,
    { attachments: [{ objectId: upload.body.objectId }] },
    url
  );
  const message = sent.body.message;
  return { org, me, session, message, attachment: message.attachments[0] };
};

const read = (messageId: string, attachmentId: string, token: string) =>
  fetchJson(
    "GET",
    `${url}/v1/messages/${messageId}/attachments/${attachmentId}`,
    token
  );

describe("GET /v1/messages/:messageId/attachments/:attachmentId", () => {
  it("gives a reader the attachment and a 5-minute read URL", async () => {
    const { me, message, attachment } = await withAttachment();

    const res = await read(message.id, attachment.id, me.token);

    expect(res.status).toBe(200);
    expect(res.body.attachment).toEqual(attachment);
    expect(res.body.url).toMatch(/^https:\/\/files\.test\/read\//);
    expect(files.presigned.at(-1)).toMatchObject({
      operation: "read",
      expiresInSeconds: 300,
    });
    expect(Date.parse(res.body.expiresAt)).toBeGreaterThan(Date.now());
  });

  it("is 404 for someone who cannot read the session", async () => {
    const { org, message, attachment } = await withAttachment();
    const stranger = await signIn(org);

    const res = await read(message.id, attachment.id, stranger.token);

    expect(res.status).toBe(404);
  });

  it("is 404 for an attachment of the message of a deleted message", async () => {
    const { me, message, attachment } = await withAttachment();
    await deleteMessage(message.id, me.token, url);

    const res = await read(message.id, attachment.id, me.token);

    expect(res.status).toBe(404);
  });

  it("is 404 for an attachment that is on another message", async () => {
    const first = await withAttachment();
    const second = await withAttachment();

    const res = await read(
      first.message.id,
      second.attachment.id,
      first.me.token
    );

    expect(res.status).toBe(404);
  });

  it("is 404 once tereo has expired the object", async () => {
    const { me, message, attachment } = await withAttachment();
    for (const id of files.objects.keys()) files.expire(id);

    const res = await read(message.id, attachment.id, me.token);

    expect(res.status).toBe(404);
  });

  it("is 400 for an id that is not a UUID", async () => {
    const { me, message } = await withAttachment();

    const res = await read(message.id, "nope", me.token);

    expect(res.status).toBe(400);
  });
});
