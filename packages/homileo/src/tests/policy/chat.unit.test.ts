// @module-tag unit
// @module-tag access
import { caller } from "../support/pure/policyFacts.js";
import { describe, expect, it } from "vitest";
import {
  canReadChat,
  canRemoveWithToken,
  canWriteChat,
} from "../../policy/index.js";

describe("canReadChat", () => {
  it.each([
    ["no permissions", {}, false],
    ["homileo.spaces.read", { permissions: ["homileo.spaces.read"] }, true],
    ["homileo.spaces.write", { permissions: ["homileo.spaces.write"] }, true],
    ["homileo.spaces.admin", { permissions: ["homileo.spaces.admin"] }, true],
    ["tereo admin", { permissions: ["admin"] }, true],
    [
      "homileo.chat.admin",
      { isAdmin: true, permissions: ["homileo.chat.admin"] },
      true,
    ],
    [
      "homileo.messages.read_private",
      { permissions: ["homileo.messages.read_private"] },
      false,
    ],
    ["a kind grant", { permissions: ["support.cases.moderate"] }, false],
  ])("%s -> %s", (_name, overrides, expected) => {
    expect(canReadChat(caller(overrides))).toBe(expected);
  });
});

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

describe("canRemoveWithToken", () => {
  const readOnly = { permissions: ["homileo.spaces.read"] };
  const writer = { permissions: ["homileo.spaces.write"] };

  it.each([
    ["read-only, removing itself", readOnly, "p-caller", true],
    ["read-only, removing someone else", readOnly, "p-other", false],
    ["writer, removing someone else", writer, "p-other", true],
    ["no permissions, removing itself", {}, "p-caller", true],
  ])("%s -> %s", (_name, overrides, target, expected) => {
    expect(canRemoveWithToken(caller(overrides), target)).toBe(expected);
  });
});
