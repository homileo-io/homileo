// @module-tag int
// @module-tag sessions
import { purgeOrganizations, signIn } from "../../../../support/signedIn.js";
import { chatFixtures } from "../../../../support/chatFixtures.js";
import { prisma } from "../../../../../utils/db/prisma.js";
import { fetchJson } from "../../../../support/http.js";
import { afterAll, describe, expect, it } from "vitest";
import env from "../../../../../env.js";
import { v7 as uuidv7 } from "uuid";

const URL = `${env.PUBLIC_URL}/v1/sessions`;
const fixtures = chatFixtures();
const orgs: string[] = [];
const newOrg = () => {
  const org = uuidv7();
  orgs.push(org);
  return org;
};

afterAll(async () => {
  await purgeOrganizations(orgs);
  await fixtures.cleanup();
});

/** A space-less group the signed-in person owns. */
const ownedGroup = async (me: { principalId: string; org: string }) => {
  const s = await fixtures.session({ org: me.org });
  await fixtures.participant(s, { id: me.principalId }, "owner");
  return s;
};

describe("GET /v1/sessions/:sessionId", () => {
  it("returns the session and the caller's participant", async () => {
    const me = await signIn(newOrg());
    const s = await ownedGroup(me);

    const res = await fetchJson("GET", `${URL}/${s.id}`, me.token);

    expect(res.status).toBe(200);
    expect(res.body.session).toMatchObject({ id: s.id, lastSeq: 0 });
    expect(res.body.participant).toMatchObject({
      principalId: me.principalId,
      role: "owner",
      lastReadSeq: 0,
    });
  });

  it("returns a null participant to a reader who has not joined", async () => {
    const org = newOrg();
    const me = await signIn(org);
    const space = await fixtures.space({ org, visibility: "public" });
    const s = await fixtures.session({ org, space, access: "space" });

    const res = await fetchJson("GET", `${URL}/${s.id}`, me.token);

    expect(res.status).toBe(200);
    expect(res.body.participant).toBeNull();
  });

  it("answers 404 for a session in another organization", async () => {
    const me = await signIn(newOrg());
    const s = await fixtures.session({ org: newOrg() });
    await fixtures.participant(s, { id: me.principalId });

    const res = await fetchJson("GET", `${URL}/${s.id}`, me.token);

    expect(res.status).toBe(404);
  });

  it("answers 404 for an unknown id and 400 for one that is not a UUID", async () => {
    const me = await signIn(newOrg());

    const unknown = await fetchJson("GET", `${URL}/${uuidv7()}`, me.token);
    const bad = await fetchJson("GET", `${URL}/nope`, me.token);

    expect(unknown.status).toBe(404);
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("invalid_request");
  });

  it("answers 404 to a participant who left", async () => {
    const org = newOrg();
    const me = await signIn(org);
    const s = await fixtures.session({ org });
    await fixtures.participant(s, { id: me.principalId }, "member", {
      left: true,
    });

    const res = await fetchJson("GET", `${URL}/${s.id}`, me.token);

    expect(res.status).toBe(404);
  });
});

describe("PATCH /v1/sessions/:sessionId", () => {
  it("updates the given fields and replaces metadata whole", async () => {
    const me = await signIn(newOrg());
    const s = await ownedGroup(me);
    await prisma.session.update({
      where: { id: s.id },
      data: { metadata: { old: 1 }, externalRef: "keep" },
    });

    const res = await fetchJson("PATCH", `${URL}/${s.id}`, me.token, {
      name: "Renamed",
      metadata: { fresh: true },
    });

    expect(res.status).toBe(200);
    expect(res.body.session).toMatchObject({
      name: "Renamed",
      metadata: { fresh: true },
      externalRef: "keep",
    });
  });

  it("clears the state and externalRef with null", async () => {
    const me = await signIn(newOrg());
    const s = await ownedGroup(me);
    await prisma.session.update({
      where: { id: s.id },
      data: { externalRef: "x" },
    });

    const res = await fetchJson("PATCH", `${URL}/${s.id}`, me.token, {
      externalRef: null,
    });

    expect(res.body.session.externalRef).toBeNull();
  });

  it("answers 400 invalid_state for a state the space-less group cannot have", async () => {
    const me = await signIn(newOrg());
    const s = await ownedGroup(me);

    const res = await fetchJson("PATCH", `${URL}/${s.id}`, me.token, {
      state: "open",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_state");
  });

  it.each([
    ["an empty body", {}],
    ["an empty name", { name: "" }],
    ["an unknown key", { access: "space" }],
    ["metadata with a bad key", { metadata: { "bad key": 1 } }],
  ])("answers 400 to %s", async (_name, body) => {
    const me = await signIn(newOrg());
    const s = await ownedGroup(me);

    const res = await fetchJson("PATCH", `${URL}/${s.id}`, me.token, body);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });

  it("answers 409 resource_archived for an archived session", async () => {
    const me = await signIn(newOrg());
    const s = await ownedGroup(me);
    await prisma.session.update({
      where: { id: s.id },
      data: { archivedAt: new Date() },
    });

    const res = await fetchJson("PATCH", `${URL}/${s.id}`, me.token, {
      name: "x",
    });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("resource_archived");
  });
});
