// @module-tag unit
// @module-tag messages
import { parseBody, PARSE_MAX_LENGTH } from "../../utils/markdown.js";
import { parseMentions } from "../../utils/mentions.js";
import { describe, expect, it } from "vitest";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const none = { users: [], here: false, session: false };

describe("parseMentions", () => {
  it.each([
    ["a plain user mention", `hi <@${A}>`, { ...none, users: [A] }],
    ["two users in order", `<@${B}> and <@${A}>`, { ...none, users: [B, A] }],
    ["duplicates collapse", `<@${A}> <@${A}>`, { ...none, users: [A] }],
    [
      "an uppercase id is lowercased",
      `<@${A.toUpperCase()}>`,
      { ...none, users: [A] },
    ],
    ["<!here> inside text", "ping <!here> now", { ...none, here: true }],
    ["<!session>", "<!session>", { ...none, session: true }],
    ["inline code is ignored", `\`<@${A}>\``, none],
    ["a fenced block is ignored", `\`\`\`\n<@${A}> <!here>\n\`\`\``, none],
    ["an empty body", "", none],
  ])("%s", (_name, markdown, want) => {
    expect(parseMentions(markdown)).toEqual(want);
  });
});

describe("parseMentions of a body read as plain text", () => {
  const long = (markdown: string) =>
    `${markdown}\n${"x".repeat(PARSE_MAX_LENGTH)}`;

  it.each([
    ["a plain user mention", `hi <@${A}>`, { ...none, users: [A] }],
    [
      "<!here> and <!session>",
      "<!here> <!session>",
      { ...none, here: true, session: true },
    ],
    ["inline code is ignored", `\`<@${A}>\` <!here>`, { ...none, here: true }],
    [
      "a fenced block is ignored",
      `\`\`\`ts\n<@${A}>\n\`\`\`\n<!session>`,
      { ...none, session: true },
    ],
    [
      "a tilde fence closes only on tildes",
      `~~~\n\`\`\`\n<@${A}>\n~~~~\n<@${B}>`,
      { ...none, users: [B] },
    ],
    ["an unclosed fence runs to the end", `\`\`\`\n<@${A}>`, none],
  ])("%s", (_name, markdown, want) => {
    expect(parseBody(long(markdown))).toBeNull();
    expect(parseMentions(long(markdown))).toEqual(want);
  });
});
