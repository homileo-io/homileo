// @module-tag int
// @module-tag platform
import { fetchJson } from "../../support/http.js";
import { describe, expect, it } from "vitest";
import env from "../../../env.js";

describe("GET /health", () => {
  it("answers 200 with postgres and redis ok", async () => {
    const res = await fetchJson("GET", `${env.PUBLIC_URL}/health`, null);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", postgres: "ok", redis: "ok" });
  });
});
