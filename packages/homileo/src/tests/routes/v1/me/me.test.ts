// @module-tag int
// @module-tag auth
import { fetchJson } from "../../../support/http.js";
import { describe, expect, it } from "vitest";
import env from "../../../../env.js";
import { v7 as uuidv7 } from "uuid";

const ME = `${env.PUBLIC_URL}/v1/me`;
const personToken = (userId = uuidv7(), org: string | null = uuidv7()) =>
  `test-token-${userId}${org ? `|org=${org}` : ""}`;
const serviceToken = (userId = uuidv7(), org: string | null = null) =>
  `test-token-${userId}|client=${userId}${org ? `|org=${org}` : ""}`;

describe("GET /v1/me", () => {
  it("returns 401 without a token", async () => {
    const res = await fetchJson("GET", ME, null);

    expect(res.status).toBe(401);
  });

  it("creates a user principal on first request and returns the same one after", async () => {
    const userId = uuidv7();

    const first = await fetchJson("GET", ME, personToken(userId));
    const second = await fetchJson("GET", ME, personToken(userId));

    expect(first.status).toBe(200);
    expect(first.body.principal).toMatchObject({
      kind: "user",
      tereoUserId: userId,
      isBot: false,
    });
    expect(second.body.principal.id).toBe(first.body.principal.id);
  });

  it("marks a service account as a bot", async () => {
    const res = await fetchJson("GET", ME, serviceToken(uuidv7(), uuidv7()));

    expect(res.status).toBe(200);
    expect(res.body.principal.isBot).toBe(true);
  });

  it("takes the organization from the token", async () => {
    const org = uuidv7();

    const res = await fetchJson("GET", ME, personToken(uuidv7(), org));

    expect(res.body.organizationId).toBe(org);
  });

  it("returns the token's permissions", async () => {
    const res = await fetchJson(
      "GET",
      ME,
      `${personToken()}|perms=homileo.spaces.read,homileo.chat.admin`
    );

    expect(res.body.permissions).toEqual([
      "homileo.spaces.read",
      "homileo.chat.admin",
    ]);
  });

  it("ignores X-Organization-ID when the token has an organization", async () => {
    const tokenOrg = uuidv7();

    const res = await fetchJson(
      "GET",
      ME,
      personToken(uuidv7(), tokenOrg),
      undefined,
      { "X-Organization-ID": uuidv7() }
    );

    expect(res.status).toBe(200);
    expect(res.body.organizationId).toBe(tokenOrg);
  });

  it("answers 400 organization_required for a person without an organization", async () => {
    const res = await fetchJson("GET", ME, personToken(uuidv7(), null));

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("organization_required");
  });

  it("answers 400 organization_required for a service account without an organization, even with X-Organization-ID", async () => {
    const res = await fetchJson("GET", ME, serviceToken(), undefined, {
      "X-Organization-ID": uuidv7(),
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("organization_required");
  });
});
