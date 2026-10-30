// @module-tag unit
// @module-tag messages
import { ReactionParamsSchema } from "../../../../../../../routes/v1/messages/message/reactions/reaction/schemas.js";
import { describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";

const parse = (emoji: string) =>
  ReactionParamsSchema.safeParse({ messageId: uuidv7(), emoji });

describe("reaction emoji", () => {
  it.each([
    ["a plain emoji", "👍"],
    ["an emoji with a skin tone", "👍🏽"],
    ["a ZWJ sequence", "👩‍👩‍👧"],
    ["a flag", "🇸🇪"],
    ["a shortcode", ":party_parrot:"],
    ["a shortcode with + and -", ":+1:"],
    ["a 62-character shortcode", `:${"a".repeat(62)}:`],
  ])("accepts %s", (_name, emoji) => {
    expect(parse(emoji).success).toBe(true);
  });

  it.each([
    ["plain text", "abc"],
    ["two emoji", "👍👍"],
    ["an emoji with text", "👍a"],
    ["an empty value", ""],
    ["a shortcode with upper case", ":Party:"],
    ["an empty shortcode", "::"],
    ["a 63-character shortcode", `:${"a".repeat(63)}:`],
    ["a 70-character shortcode", `:${"a".repeat(68)}:`],
    ["an unclosed shortcode", ":party"],
    ["a shortcode with a space", ":a b:"],
  ])("refuses %s", (_name, emoji) => {
    expect(parse(emoji).success).toBe(false);
  });

  it("refuses a message id that is not a UUID", () => {
    expect(
      ReactionParamsSchema.safeParse({ messageId: "x", emoji: "👍" }).success
    ).toBe(false);
  });
});
