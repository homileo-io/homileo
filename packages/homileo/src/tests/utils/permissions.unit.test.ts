// @module-tag unit
// @module-tag auth
import { hasPermission } from "../../utils/permissions.js";
import { describe, expect, it } from "vitest";

describe("hasPermission", () => {
  it.each([
    [["homileo.chat.admin"], "homileo.chat.write", true],
    [["homileo.spaces.write"], "homileo.spaces.read", true],
    [["homileo.spaces.read"], "homileo.spaces.write", false],
    [["admin"], "support.cases.read", true],
    [[], "homileo.spaces.read", false],
  ])("%j against %s is %s", (held, required, want) => {
    expect(hasPermission(held, required)).toBe(want);
  });
});
