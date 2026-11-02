// @module-tag unit
// @module-tag websocket
import { failureAck, failureCode } from "../../websocket/failures.js";
import { describe, expect, it } from "vitest";

const withCode = (code: string) =>
  Object.assign(new Error("database"), { code });

describe("socket failure codes", () => {
  it.each([
    ["a transaction that could not start (P2028)", withCode("P2028")],
    ["a lock wait past lock_timeout (55P03)", withCode("55P03")],
  ])("answers temporarily_unavailable to %s", (_name, err) => {
    expect(failureCode(err)).toBe("temporarily_unavailable");
    expect(failureAck(err).code).toBe("temporarily_unavailable");
  });

  it("answers server_error to anything else", () => {
    expect(failureCode(new Error("boom"))).toBe("server_error");
    expect(failureAck(withCode("23505"))).toEqual({
      code: "server_error",
      message: "Something went wrong",
    });
  });
});
