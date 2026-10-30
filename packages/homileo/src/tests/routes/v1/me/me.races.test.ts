// @module-tag int
// @module-tag auth
// @module-tag race
import { prisma } from "../../../../utils/db/prisma.js";
import { fetchJson } from "../../../support/http.js";
import { describe, expect, it } from "vitest";
import env from "../../../../env.js";
import { v7 as uuidv7 } from "uuid";

describe("GET /v1/me races", () => {
  it("creates one principal when a new user's first requests arrive together", async () => {
    const userId = uuidv7();
    const org = uuidv7();

    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        fetchJson(
          "GET",
          `${env.PUBLIC_URL}/v1/me`,
          `test-token-${userId}|org=${org}`
        )
      )
    );

    expect(responses.every((r) => r.status === 200)).toBe(true);
    expect(new Set(responses.map((r) => r.body.principal.id)).size).toBe(1);
    const rows = await prisma.principal.count({
      where: { tereoUserId: userId },
    });
    expect(rows).toBe(1);
  });
});
