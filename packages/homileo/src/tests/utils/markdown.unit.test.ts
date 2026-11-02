// @module-tag unit
// @module-tag messages
import { MESSAGE_BODY_MAX } from "../../routes/v1/sessions/session/messages/schemas.js";
import { beforeAll, describe, expect, it } from "vitest";
import { parseMentions } from "../../utils/mentions.js";
import {
  measureMarkup,
  parseBody,
  PARSE_MAX_DEPTH,
  PARSE_MAX_LENGTH,
  PARSE_MAX_MARKUP,
  PARSE_MAX_WORK,
  plainText,
} from "../../utils/markdown.js";

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

// Whitespace to `trim()` and `\s`, but not to micromark: none of these makes a line blank.
const UNICODE_SPACES = [
  ["NBSP", "\u00a0"],
  ["\\v", "\v"],
  ["\\f", "\f"],
  ["U+3000", "\u3000"],
  ["U+2028", "\u2028"],
  ["U+FEFF", "\ufeff"],
] as const;

describe("measureMarkup", () => {
  it.each([
    ["plain prose", "just some words, no markup.", 0, 0, 1],
    [
      "emphasis, strikethrough, link and image delimiters",
      "a *b* _c_ ~~d~~ [e](f) ![g](h)!",
      13,
      0,
      1,
    ],
    ["nested quote and list markers", "> > - 1. x\n> y", 5, 4, 11],
    ["a marker needs a space after it", "+x 1.z", 0, 0, 1],
    ["a fence after a heading opens code", "# a\n```\n---\n=", 2, 0, 4],
    ["\\r ends a line", ">x\r>y\r\n>z", 3, 1, 8],
    ["\\r\\n is one line ending", "a\r\nb\r\nc", 0, 0, 3],
    ["blank lines keep containers open", "- - a\n\n\n", 2, 2, 9],
    ["indent counts as nesting", "- a\n\t- b\n    - c", 3, 1, 11],
    ["indent between markers counts", "> - a\n>\n>   b", 4, 2, 11],
    ["a lazy line counts its paragraph", "> a\nb\nc\nd", 1, 1, 11],
    [
      "a line after a blank one closes what it does not continue",
      "> a\n\nb\nc",
      1,
      1,
      6,
    ],
    ["indent alone opens nothing", "a\n" + " ".repeat(200) + "x\nb", 0, 0, 3],
    ["fenced code counts no markup", "```\n> > > *x*\n```\nz", 2, 0, 4],
    [
      "a fence closed only by spaces and tabs",
      "```\n```\u00a0\n> *x*\n``` \t\n> y",
      3,
      1,
      6,
    ],
    ["a fence whose info holds U+2028", "```a\u2028b\n> *x*\n```", 2, 0, 3],
    ["a leading BOM is not text", "\ufeff> > *x*", 5, 2, 3],
    ["a BOM after the start is text", "a\n\ufeff> x", 0, 0, 2],
  ])("%s", (_name, markdown, count, depth, work) => {
    expect(measureMarkup(markdown)).toEqual({ count, depth, work });
  });
});

describe("parseBody", () => {
  it("parses a body within both limits", () => {
    expect(parseBody("**hi**")?.type).toBe("root");
  });

  it.each([
    ["longer than PARSE_MAX_LENGTH", "a".repeat(PARSE_MAX_LENGTH + 1)],
    [
      "with more markup than PARSE_MAX_MARKUP",
      "a*".repeat(PARSE_MAX_MARKUP + 1),
    ],
    ["nested deeper than PARSE_MAX_DEPTH", ">".repeat(PARSE_MAX_DEPTH + 1)],
  ])("reads a body %s as plain text", (_name, markdown) => {
    expect(parseBody(markdown)).toBeNull();
  });

  const blanks = (head: string, line: string) =>
    (head + line.repeat(PARSE_MAX_LENGTH)).slice(0, PARSE_MAX_LENGTH);
  const tabNested = Array.from(
    { length: 40 },
    (_, i) => "\t".repeat(i) + "- a"
  ).join("\n");

  it.each([
    ["'- ' nesting", blanks("- ".repeat(100) + "a\n", "\n")],
    ["'* ' nesting", blanks("* ".repeat(100) + "a\n", "\n")],
    ["'1. ' nesting", blanks("1. ".repeat(100) + "a\n", "\n")],
    ["'- ' nesting ended by \\r", blanks("- ".repeat(100) + "a\r", "\r")],
    [
      "'- ' nesting ended by \\r\\n",
      blanks("- ".repeat(100) + "a\r\n", "\r\n"),
    ],
    ["tab-indented nesting", blanks(tabNested, "\n")],
    [
      "two-space-indented nesting",
      blanks(tabNested.replaceAll("\t", "  "), "\n"),
    ],
  ])("reads %s followed by blank lines as plain text", (_name, markdown) => {
    expect(markdown.length).toBeLessThanOrEqual(PARSE_MAX_LENGTH);
    expect(measureMarkup(markdown).depth).toBeLessThanOrEqual(PARSE_MAX_DEPTH);
    expect(measureMarkup(markdown).work).toBeGreaterThan(PARSE_MAX_WORK);
    expect(parseBody(markdown)).toBeNull();
  });

  it("parses a body of the most lines with four open containers", () => {
    const markdown = blanks("> - > - a\n", "\n");
    expect(measureMarkup(markdown).work).toBeLessThanOrEqual(PARSE_MAX_WORK);
    expect(parseBody(markdown)).not.toBeNull();
  });

  it.each([
    ["a quote followed by lazy lines", "> a\n" + "b\n".repeat(4990)],
    [
      "nine quotes followed by lazy lines",
      "> ".repeat(9) + "a\n" + "b\n".repeat(4980),
    ],
    [
      "quote lines between short lazy runs",
      ("> a\n" + "b\n".repeat(30)).repeat(150),
    ],
    ["a list item followed by lazy lines", "- a\n" + "b\n".repeat(4990)],
    [
      "lazy lines under-indented for their item",
      "10. a\n" + "  b\n".repeat(2400),
    ],
    [
      "list markers that cannot interrupt a paragraph",
      "> a\n" + "c\n".repeat(1000) + "2. b\n".repeat(490),
    ],
    ...UNICODE_SPACES.flatMap(([name, space]) => [
      [`lazy lines of ${name}`, "> a\n" + `${space}\n`.repeat(4990)],
      [
        `lazy lines between lines of ${name}`,
        "> a\n" + `b\n${space}\n`.repeat(2490),
      ],
      [
        `nine quotes followed by lines of ${name}`,
        "> ".repeat(9) + "a\n" + `b\n${space}\n`.repeat(2480),
      ],
    ]),
  ])("reads %s as plain text", (_name, markdown) => {
    expect(markdown.length).toBeLessThanOrEqual(PARSE_MAX_LENGTH);
    expect(measureMarkup(markdown).work).toBeGreaterThan(PARSE_MAX_WORK);
    expect(parseBody(markdown)).toBeNull();
  });

  it.each([
    ["'>' nesting", "\ufeff" + ">".repeat(3000) + " a", "depth"],
    ["'- ' nesting", "\ufeff" + "- ".repeat(2000) + "a", "depth"],
    [
      "a quote followed by lazy lines",
      "\ufeff> a\n" + "b\n".repeat(4990),
      "work",
    ],
  ] as const)(
    "reads %s after a leading BOM as plain text",
    (_name, markdown, limit) => {
      expect(markdown.length).toBeLessThanOrEqual(PARSE_MAX_LENGTH);
      const markup = measureMarkup(markdown);
      if (limit === "depth") {
        expect(markup.depth).toBeGreaterThan(PARSE_MAX_DEPTH);
      } else {
        expect(markup.work).toBeGreaterThan(PARSE_MAX_WORK);
      }
      expect(parseBody(markdown)).toBeNull();
    }
  );

  it.each([
    [
      "a code block with a deeply indented line",
      "```\n" + " ".repeat(200) + "x\n```\n" + "some text\n".repeat(900),
    ],
    [
      "CRLF line endings",
      "> ".repeat(10) + "a\r\n\r\n" + "text\r\n\r\n".repeat(1200),
    ],
    [
      "a quote, a blank line and a long reply",
      "> quoted\n> more\n\n" + "reply line\n".repeat(900),
    ],
    ["code full of markup", "```\n" + "> - *a* [b] _c_\n".repeat(500) + "```"],
  ])("parses an ordinary message: %s", (_name, markdown) => {
    expect(markdown.length).toBeLessThanOrEqual(PARSE_MAX_LENGTH);
    expect(parseBody(markdown)).not.toBeNull();
  });
});

describe("plainText of a body read as plain text", () => {
  it("keeps the markup and names the mentions", () => {
    const body = `**hi** <@${A}> <!here> ${"x".repeat(PARSE_MAX_LENGTH)}`;
    expect(plainText(body, names)).toBe(
      `**hi** @Ada @here ${"x".repeat(PARSE_MAX_LENGTH)}`
    );
  });
});

describe("pathological bodies", () => {
  const filled = (head: string, size: number) =>
    (head + " word".repeat(size)).slice(0, size);

  // The fastest of three runs, so a busy machine does not fail the bound.
  const readTime = (markdown: string): number => {
    const times = [0, 1, 2].map(() => {
      const started = performance.now();
      const tree = parseBody(markdown);
      parseMentions(markdown, tree);
      plainText(markdown, names, tree);
      return performance.now() - started;
    });
    return Math.min(...times);
  };

  beforeAll(() => {
    readTime(filled("warm *up*", PARSE_MAX_LENGTH));
  });

  it.each([
    ["> nesting", ">".repeat(MESSAGE_BODY_MAX - 1) + "x"],
    ["'> ' nesting", "> ".repeat(MESSAGE_BODY_MAX / 2 - 1) + "x"],
    ["'- ' nesting", "- ".repeat(MESSAGE_BODY_MAX / 2 - 1) + "x"],
    ["nested emphasis", "*a _".repeat(5000) + "b" + "_ a*".repeat(4999)],
    ["a delimiter run", "*".repeat(MESSAGE_BODY_MAX / 2) + "x".repeat(10)],
    ["nested images", "![a ".repeat(5000) + "x" + "](u)".repeat(4999)],
    ["setext headings", "a\n=\n".repeat(MESSAGE_BODY_MAX / 4)],
    ["sibling block quotes", ">x\n\n".repeat(MESSAGE_BODY_MAX / 4)],
  ])("reads %s in under 100 ms", (_name, markdown) => {
    expect(markdown.length).toBeLessThanOrEqual(MESSAGE_BODY_MAX);
    expect(parseBody(markdown)).toBeNull();
    expect(readTime(markdown)).toBeLessThan(100);
  });

  const atLimit = (head: string) => filled(head, PARSE_MAX_LENGTH);
  const half = PARSE_MAX_MARKUP / 2;
  const withinLimits = (markdown: string): boolean => {
    const { count, depth, work } = measureMarkup(markdown);
    return (
      markdown.length <= PARSE_MAX_LENGTH &&
      count <= PARSE_MAX_MARKUP &&
      depth <= PARSE_MAX_DEPTH &&
      work <= PARSE_MAX_WORK
    );
  };
  // `head` and as many `line`s as are still parsed: one more is read as plain text.
  const mostLines = (head: string, line: string): string => {
    let n = 0;
    while (withinLimits(head + line.repeat(n + 1))) n++;
    return head + line.repeat(n);
  };

  it.each([
    ["'- ' nesting", atLimit("- ".repeat(PARSE_MAX_DEPTH) + "x")],
    ["'> ' nesting", atLimit("> ".repeat(PARSE_MAX_DEPTH) + "x")],
    [
      "lines of '- ' nesting",
      atLimit(`${"- ".repeat(PARSE_MAX_DEPTH)}x\n`.repeat(5)),
    ],
    [
      "nested images",
      atLimit(
        "![a ".repeat(PARSE_MAX_MARKUP / 3) +
          "x" +
          "](u)".repeat(PARSE_MAX_MARKUP / 3 - 1)
      ),
    ],
    [
      "nested emphasis",
      atLimit("a*a _".repeat(half / 2) + "b" + "_ a*".repeat(half / 2 - 1)),
    ],
    ["sibling block quotes", atLimit(">x\n\n".repeat(PARSE_MAX_MARKUP))],
    ["setext headings", atLimit("a\n=\n".repeat(PARSE_MAX_MARKUP))],
    ["a list of links", atLimit("- [a](u)\n".repeat(PARSE_MAX_MARKUP / 3))],
    ["an unmatched bracket before a long paragraph", atLimit("[a [a x](u)")],
    [
      "'- ' nesting followed by blank lines",
      "- ".repeat(PARSE_MAX_DEPTH) +
        "a" +
        "\n".repeat(Math.floor(PARSE_MAX_WORK / (PARSE_MAX_DEPTH + 1)) - 1),
    ],
    ["the most lazy lines after a quote", mostLines("> a\n", "b\n")],
    ["the most indented lazy lines", mostLines("> a\n", "    b&amp;\n")],
    ["the most lazy lines after a list item", mostLines("- a\n", "b\n")],
    ["the most quote and lazy lines", mostLines("", "> a\nb\n")],
    [
      "the most lazy lines before non-interrupting markers",
      mostLines("> a\n" + "2. b\n".repeat(490), "c\n"),
    ],
  ])("parses %s at the parse limits in under 100 ms", (_name, markdown) => {
    expect(parseBody(markdown)).not.toBeNull();
    expect(readTime(markdown)).toBeLessThan(100);
  });
});
