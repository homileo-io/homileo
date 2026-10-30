// @module-tag int
// @module-tag messages
// @module-tag access
import { purgeOrganizations, signIn } from "../../../../support/signedIn.js";
import { chatFixtures } from "../../../../support/chatFixtures.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spaceApiFixtures } from "../../../../support/spaceApi.js";
import { prisma } from "../../../../../utils/db/prisma.js";
import { startV1App } from "../../../../support/v1App.js";
import { v7 as uuidv7 } from "uuid";
import {
  deleteMessage,
  editMessage,
  getMessage,
  sendMessage,
} from "../../../../support/messageApi.js";

const fixtures = chatFixtures();
const api = spaceApiFixtures();
const orgs: string[] = [];
let url: string;
let close: () => Promise<unknown>;

beforeAll(async () => {
  ({ url, close } = await startV1App());
});
afterAll(async () => {
  await close();
  await prisma.event.deleteMany({ where: { organizationId: { in: orgs } } });
  await fixtures.cleanup();
  await purgeOrganizations(orgs);
  await api.cleanup();
});

const newOrg = () => {
  const org = api.organization();
  orgs.push(org);
  return org;
};

/** A public space with an `access: space` session, a sender and a plain reader. */
const publicRoom = async () => {
  const org = newOrg();
  const space = await fixtures.space({ org, visibility: "public" });
  const session = await fixtures.session({ org, space, access: "space" });
  const sender = await signIn(org);
  const reader = await signIn(org);
  await fixtures.participant(session, { id: sender.principalId });
  const sent = await sendMessage(session.id, sender.token, { body: "hi" });
  return { org, space, session, sender, reader, id: sent.body.message.id };
};

describe("message permissions", () => {
  it("answers 404 to a caller who cannot read the message, on every route", async () => {
    const org = newOrg();
    const session = await fixtures.session({ org });
    const sender = await signIn(org);
    await fixtures.participant(session, { id: sender.principalId });
    const sent = await sendMessage(session.id, sender.token, { body: "hi" });
    const id = sent.body.message.id;
    const outsider = await signIn(org);
    const otherOrg = await signIn(newOrg());

    for (const who of [outsider, otherOrg]) {
      expect((await getMessage(id, who.token)).status).toBe(404);
      expect((await editMessage(id, who.token, { body: "x" })).status).toBe(
        404
      );
      expect((await deleteMessage(id, who.token)).status).toBe(404);
    }
  });

  it.each([
    ["session", { sessionArchived: true }],
    ["space", { spaceArchived: true }],
  ])(
    "answers 409 resource_archived for edit and delete in an archived %s",
    async (_n, o) => {
      const { space, session, sender, id } = await publicRoom();
      if (o.sessionArchived) {
        await prisma.session.update({
          where: { id: session.id },
          data: { archivedAt: new Date() },
        });
      } else {
        await prisma.space.update({
          where: { id: space.id },
          data: { archivedAt: new Date() },
        });
      }

      const edit = await editMessage(id, sender.token, { body: "x" });
      const del = await deleteMessage(id, sender.token);

      expect(edit.status).toBe(409);
      expect(edit.body.error).toBe("resource_archived");
      expect(del.status).toBe(409);
      expect(del.body.error).toBe("resource_archived");
    }
  );

  it("answers 403 to a reader who is not the sender, for edit and delete", async () => {
    const { reader, id } = await publicRoom();

    const edit = await editMessage(id, reader.token, { body: "x" });
    const del = await deleteMessage(id, reader.token);

    expect(edit.status).toBe(403);
    expect(edit.body.error).toBe("forbidden");
    expect(del.status).toBe(403);
    expect(del.body.error).toBe("forbidden");
  });

  it("lets a space moderator delete but not edit another's message", async () => {
    const { space, session, id } = await publicRoom();
    const moderator = await signIn(space.organizationId);
    await fixtures.member(space, { id: moderator.principalId }, "moderator");
    await fixtures.participant(session, { id: moderator.principalId });

    const edit = await editMessage(id, moderator.token, { body: "x" });
    const del = await deleteMessage(id, moderator.token);

    expect(edit.status).toBe(403);
    expect(del.status).toBe(200);
  });

  it("decision 1: a sender who left can neither edit nor delete", async () => {
    const { session, sender, id } = await publicRoom();
    await prisma.sessionParticipant.update({
      where: {
        sessionId_userId: { sessionId: session.id, userId: sender.principalId },
      },
      data: { leftAt: new Date() },
    });

    const edit = await editMessage(id, sender.token, { body: "x" });
    const del = await deleteMessage(id, sender.token);

    expect(edit.status).toBe(403);
    expect(del.status).toBe(403);
    expect((await getMessage(id, sender.token)).status).toBe(200);
  });

  it("answers 403 edit_window_closed past the kind's window, but still lets the sender delete", async () => {
    const org = newOrg();
    const kind = await api.kind(`msg-edit:${uuidv7().slice(-8)}`, {
      editWindowSeconds: 1,
    });
    const space = await fixtures.space({ org, kind });
    const session = await fixtures.session({ org, space, access: "space" });
    const { principal, token } = await api.actor(org);
    await fixtures.member(space, principal);
    await fixtures.participant(session, principal);
    const sent = await sendMessage(session.id, token, { body: "hi" }, url);
    const id = sent.body.message.id;
    const fresh = await editMessage(id, token, { body: "a" }, url);
    await prisma.$executeRaw`UPDATE "chat"."messages" SET created_at = now() - interval '1 hour' WHERE id = ${id}::uuid`;

    const late = await editMessage(id, token, { body: "b" }, url);
    const del = await deleteMessage(id, token, url);

    expect(fresh.status).toBe(200);
    expect(late.status).toBe(403);
    expect(late.body.error).toBe("edit_window_closed");
    expect(del.status).toBe(200);
  });

  it("answers plain 403 forbidden, not edit_window_closed, to someone else past the window", async () => {
    const org = newOrg();
    const kind = await api.kind(`msg-edit:${uuidv7().slice(-8)}`, {
      editWindowSeconds: 1,
    });
    const space = await fixtures.space({ org, kind, visibility: "public" });
    const session = await fixtures.session({ org, space, access: "space" });
    const a = await api.actor(org);
    const b = await api.actor(org);
    await fixtures.participant(session, a.principal);
    const sent = await sendMessage(session.id, a.token, { body: "hi" }, url);
    const id = sent.body.message.id;
    await prisma.$executeRaw`UPDATE "chat"."messages" SET created_at = now() - interval '1 hour' WHERE id = ${id}::uuid`;

    const res = await editMessage(id, b.token, { body: "x" }, url);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden");
  });
});
