// @module-tag int
// @module-tag sessions
import { purgeOrganizations, signIn } from "../../../../support/signedIn.js";
import { personToken } from "../../../../support/tokens.js";
import { prisma } from "../../../../../utils/db/prisma.js";
import { fetchJson } from "../../../../support/http.js";
import { afterAll, describe, expect, it } from "vitest";
import env from "../../../../../env.js";
import { v7 as uuidv7 } from "uuid";

const URL = `${env.PUBLIC_URL}/v1/sessions/direct`;
const orgs: string[] = [];
const newOrg = () => {
  const org = uuidv7();
  orgs.push(org);
  return org;
};

afterAll(() => purgeOrganizations(orgs));

describe("POST /v1/sessions/direct", () => {
  it("creates a DM with two member participants and a sorted direct key", async () => {
    const org = newOrg();
    const a = await signIn(org);
    const b = await signIn(org);

    const res = await fetchJson("POST", URL, a.token, {
      principalId: b.principalId,
    });

    expect(res.status).toBe(201);
    expect(res.body.session).toMatchObject({
      type: "direct",
      access: "members",
      spaceId: null,
      createdBy: a.principalId,
    });
    const row = await prisma.session.findUniqueOrThrow({
      where: { id: res.body.session.id },
    });
    expect(row.directKey).toBe([a.principalId, b.principalId].sort().join(":"));
    const rows = await prisma.sessionParticipant.findMany({
      where: { sessionId: row.id },
    });
    expect(rows.map((r) => [r.userId, r.role]).sort()).toEqual(
      [
        [a.principalId, "member"],
        [b.principalId, "member"],
      ].sort()
    );
  });

  it("returns the same session with 200 from the other side", async () => {
    const org = newOrg();
    const a = await signIn(org);
    const b = await signIn(org);
    const first = await fetchJson("POST", URL, a.token, {
      principalId: b.principalId,
    });

    const again = await fetchJson("POST", URL, a.token, {
      principalId: b.principalId,
    });
    const other = await fetchJson("POST", URL, b.token, {
      principalId: a.principalId,
    });

    expect(again.status).toBe(200);
    expect(other.status).toBe(200);
    expect(again.body.session.id).toBe(first.body.session.id);
    expect(other.body.session.id).toBe(first.body.session.id);
  });

  it("keeps a separate DM for the same pair in each organization", async () => {
    const a = await signIn(newOrg());
    const b = await signIn(a.org);
    const first = await fetchJson("POST", URL, a.token, {
      principalId: b.principalId,
    });
    const otherOrg = newOrg();

    const elsewhere = await fetchJson(
      "POST",
      URL,
      personToken({ userId: a.tereoUserId, org: otherOrg }),
      { principalId: b.principalId }
    );

    expect(first.status).toBe(201);
    expect(elsewhere.status).toBe(201);
    expect(elsewhere.body.session.id).not.toBe(first.body.session.id);
  });

  it("refuses a DM with oneself", async () => {
    const a = await signIn(newOrg());

    const res = await fetchJson("POST", URL, a.token, {
      principalId: a.principalId,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("cannot_dm_self");
  });

  it("answers 404 for an unknown principal", async () => {
    const a = await signIn(newOrg());

    const res = await fetchJson("POST", URL, a.token, {
      principalId: uuidv7(),
    });

    expect(res.status).toBe(404);
  });

  it.each([
    ["a missing principalId", {}],
    ["a principalId that is not a UUID", { principalId: "nope" }],
    ["an unknown key", { principalId: uuidv7(), name: "x" }],
  ])("answers 400 to %s", async (_name, body) => {
    const a = await signIn(newOrg());

    const res = await fetchJson("POST", URL, a.token, body);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });

  it("is not readable by an admin who is no participant", async () => {
    const org = newOrg();
    const a = await signIn(org);
    const b = await signIn(org);
    const admin = await signIn(org, ["homileo.chat.admin"]);
    const dm = await fetchJson("POST", URL, a.token, {
      principalId: b.principalId,
    });

    const res = await fetchJson(
      "GET",
      `${env.PUBLIC_URL}/v1/sessions/${dm.body.session.id}`,
      admin.token
    );

    expect(res.status).toBe(404);
  });
});
