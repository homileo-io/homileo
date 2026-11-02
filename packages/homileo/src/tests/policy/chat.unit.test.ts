// @module-tag unit
// @module-tag access
import { caller } from "../support/pure/policyFacts.js";
import { canWriteChat } from "../../policy/index.js";
import { describe, expect, it } from "vitest";

describe("canWriteChat", () => {
  it.each([
    ["no permissions", {}, false],
    ["homileo.spaces.read", { permissions: ["homileo.spaces.read"] }, false],
    ["homileo.spaces.write", { permissions: ["homileo.spaces.write"] }, true],
    ["homileo.spaces.admin", { permissions: ["homileo.spaces.admin"] }, true],
    ["tereo admin", { permissions: ["admin"] }, true],
    [
      "homileo.chat.admin",
      { isAdmin: true, permissions: ["homileo.chat.admin"] },
      true,
    ],
    ["a kind grant", { permissions: ["support.cases.moderate"] }, false],
  ])("%s -> %s", (_name, overrides, expected) => {
    expect(canWriteChat(caller(overrides))).toBe(expected);
  });
});
