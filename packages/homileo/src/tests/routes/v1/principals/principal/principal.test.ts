// @module-tag int
// @module-tag auth
import { personToken } from "../../../../support/tokens.js";
import { fetchJson } from "../../../../support/http.js";
import { describe, expect, it } from "vitest";
import env from "../../../../../env.js";
import { v7 as uuidv7 } from "uuid";

const URL = `${env.PUBLIC_URL}/v1/principals`;

describe("GET /v1/principals/:principalId", () => {
  it("returns 404 for an unknown id", async () => {
    const res = await fetchJson(
      "GET",
      `${URL}/${uuidv7()}`,
      personToken({ org: uuidv7() })
    );

    expect(res.status).toBe(404);
  });

  it("returns 400 for an id that is not a UUID", async () => {
    const res = await fetchJson(
      "GET",
      `${URL}/nope`,
      personToken({ org: uuidv7() })
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });

  it("returns any principal to a caller in another organization", async () => {
    const me = await fetchJson(
      "GET",
      `${env.PUBLIC_URL}/v1/me`,
      personToken({ org: uuidv7() })
    );

    const res = await fetchJson(
      "GET",
      `${URL}/${me.body.principal.id}`,
      personToken({ org: uuidv7() })
    );

    expect(res.status).toBe(200);
    expect(res.body.principal).toMatchObject({
      id: me.body.principal.id,
      kind: "user",
      tereoUserId: me.body.principal.tereoUserId,
      isBot: false,
    });
    expect(Object.keys(res.body.principal).sort()).toEqual(
      Object.keys(me.body.principal).sort()
    );
  });
});
