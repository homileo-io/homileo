// @module-tag unit
// @module-tag sessions
import { ParticipantParamsSchema } from "../../../../../../routes/v1/sessions/session/participants/participant/schemas.js";
import { ListParticipantsQuerySchema } from "../../../../../../routes/v1/sessions/session/participants/schemas.js";
import { describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";

describe("participants query", () => {
  it.each([
    ["a limit of 0", { limit: "0" }],
    ["a limit over 100", { limit: "101" }],
    ["an empty cursor", { cursor: "" }],
    ["an unknown key", { extra: "1" }],
  ])("rejects %s", (_n, q) => {
    expect(ListParticipantsQuerySchema.safeParse(q).success).toBe(false);
  });

  it("defaults the limit to 50", () => {
    expect(ListParticipantsQuerySchema.parse({}).limit).toBe(50);
  });
});

describe("participant params", () => {
  it("lower-cases both ids and rejects a non-UUID", () => {
    const id = uuidv7();
    expect(
      ParticipantParamsSchema.parse({
        sessionId: id.toUpperCase(),
        principalId: id.toUpperCase(),
      })
    ).toEqual({ sessionId: id, principalId: id });
    expect(
      ParticipantParamsSchema.safeParse({ sessionId: id, principalId: "x" })
        .success
    ).toBe(false);
  });
});
