// @module-tag unit
// @module-tag messages
import { plainText } from "../../utils/markdown.js";
import { describe, expect, it } from "vitest";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const names = new Map<string, string | null>([
  [A, "Ada"],
  [B, null],
]);

describe("plainText", () => {
  it.each([
    ["formatting is dropped", "**bold** ~~gone~~", "bold gone"],
    ["an open task item", "- [ ] todo", "[ ] todo"],
    ["a done task item", "- [x] done", "[x] done"],
    [
      "an autolink keeps the URL",
      "see https://example.com/x now",
      "see https://example.com/x now",
    ],
    ["a link keeps its text", "[docs](https://example.com)", "docs"],
    ["script tags stay literal", "<script>x</script>", "<script>x</script>"],
    ["a user mention uses the name", `hi <@${A}>`, "hi @Ada"],
    ["an uppercase mention resolves", `hi <@${A.toUpperCase()}>`, "hi @Ada"],
    ["a null name is unknown", `<@${B}>`, "@unknown"],
    [
      "a missing name is unknown",
      "<@33333333-3333-4333-8333-333333333333>",
      "@unknown",
    ],
    ["<!here> and <!session>", "<!here> <!session>", "@here @session"],
    [
      "blocks join with newlines",
      "# Title\n\npara\n\n- a\n- b",
      "Title\npara\na\nb",
    ],
    ["code keeps its text", "`x` and\n\n```\ny\n```", "x and\ny"],
    ["an empty body", "", ""],
    ["whitespace is trimmed", "  \n hi \n ", "hi"],
  ])("%s", (_name, markdown, want) => {
    expect(plainText(markdown, names)).toBe(want);
  });

  it("caps at 40,000 characters", () => {
    expect(plainText("a".repeat(50_000), names)).toHaveLength(40_000);
  });
});
