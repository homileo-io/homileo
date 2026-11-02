import { gfmStrikethroughFromMarkdown } from "mdast-util-gfm-strikethrough";
import { gfmTaskListItemFromMarkdown } from "mdast-util-gfm-task-list-item";
import { gfmStrikethrough } from "micromark-extension-gfm-strikethrough";
import { gfmTaskListItem } from "micromark-extension-gfm-task-list-item";
import { fromMarkdown } from "mdast-util-from-markdown";
import type { Nodes, Root } from "mdast";

export const MENTION_PATTERN = /<@([0-9a-f-]{36})>|<!(here|session)>/gi;

export const BODY_TEXT_LIMIT = 40_000;

/**
 * micromark's cost grows faster than linearly with nesting and with runs of
 * blocks and delimiters (a 40,000-character body can take minutes or overflow
 * the stack). A body past any of these is not parsed: it is read as plain text.
 */
export const PARSE_MAX_LENGTH = 10_000;
export const PARSE_MAX_MARKUP = 500;
export const PARSE_MAX_DEPTH = 100;
export const PARSE_MAX_WORK = 50_000;

const INLINE_MARKUP = new Set(["*", "_", "~", "[", "]"]);
const BLOCK_START = new Set(["#", "=", "-", "`", "~", "*", "_", "<"]);

const isDigit = (code: number) => code >= 48 && code <= 57;
const endsMarker = (s: string, i: number) =>
  i >= s.length ||
  s[i] === " " ||
  s[i] === "\t" ||
  s[i] === "\n" ||
  s[i] === "\r";

/**
 * Block-quote and list markers opening the line at `i`, the columns of its
 * leading indent (tabs to stops of 4), and where the markers end.
 */
const lineMarkers = (
  s: string,
  i: number
): [count: number, indent: number, end: number] => {
  let count = 0;
  let indent = 0;
  for (; s[i] === " " || s[i] === "\t"; i++) {
    indent = s[i] === "\t" ? indent + 4 - (indent % 4) : indent + 1;
  }
  for (;;) {
    while (s[i] === " " || s[i] === "\t") i++;
    if (s[i] === ">") {
      count++;
      i++;
      continue;
    }
    if (
      (s[i] === "-" || s[i] === "*" || s[i] === "+") &&
      endsMarker(s, i + 1)
    ) {
      count++;
      i++;
      continue;
    }
    let j = i;
    while (j - i < 9 && isDigit(s.charCodeAt(j))) j++;
    if (j > i && (s[j] === "." || s[j] === ")") && endsMarker(s, j + 1)) {
      count++;
      i = j + 1;
      continue;
    }
    return [count, indent, i];
  }
};

export interface Markup {
  /**
   * An upper bound on the constructs that make micromark slow: container
   * markers, lines that may start a heading, fence, thematic break or HTML
   * block, and emphasis, strikethrough, link and image delimiters.
   */
  count: number;
  /** The most block-quote and list markers opening one line. */
  depth: number;
  /**
   * An upper bound on micromark's container checks. Every line re-checks each
   * container still open, and blank and lazy lines keep them open, so each
   * line counts the most containers any line so far could have opened.
   */
  work: number;
}

export const measureMarkup = (markdown: string): Markup => {
  const markup: Markup = { count: 0, depth: 0, work: 0 };
  let open = 0;
  let i = 0;
  while (i < markdown.length) {
    const [markers, indent, end] = lineMarkers(markdown, i);
    markup.count += markers;
    markup.depth = Math.max(markup.depth, markers);
    // A nested list item needs at least two columns of indent per level.
    open = Math.max(open, markers + Math.floor(indent / 2));
    markup.work += 1 + open;
    i = end;
    if (i < markdown.length && BLOCK_START.has(markdown[i]!)) markup.count++;
    while (
      i < markdown.length &&
      markdown[i] !== "\n" &&
      markdown[i] !== "\r"
    ) {
      if (INLINE_MARKUP.has(markdown[i]!)) markup.count++;
      else if (markdown[i] === "!" && markdown[i + 1] === "[") markup.count++;
      i++;
    }
    i++;
  }
  return markup;
};

// No GFM autolink literals: a bare URL's plain text is the same without them,
// and that extension makes one unmatched "[" cost the square of its paragraph.
const parseMarkdown = (markdown: string): Root =>
  fromMarkdown(markdown, {
    extensions: [gfmStrikethrough(), gfmTaskListItem()],
    mdastExtensions: [
      gfmStrikethroughFromMarkdown(),
      gfmTaskListItemFromMarkdown(),
    ],
  });

/** The body's tree, or `null` when it is past the parse limits and read as plain text. */
export const parseBody = (markdown: string): Root | null => {
  if (markdown.length > PARSE_MAX_LENGTH) return null;
  const { count, depth, work } = measureMarkup(markdown);
  return count > PARSE_MAX_MARKUP ||
    depth > PARSE_MAX_DEPTH ||
    work > PARSE_MAX_WORK
    ? null
    : parseMarkdown(markdown);
};

const nameMentions = (text: string, names: Map<string, string | null>) =>
  text.replace(
    MENTION_PATTERN,
    (_m, id: string | undefined, kind: string | undefined) =>
      id
        ? `@${names.get(id.toLowerCase()) ?? "unknown"}`
        : `@${kind!.toLowerCase()}`
  );

const BLOCKS = new Set(["root", "list", "listItem", "blockquote"]);

const inlineText = (node: Nodes, names: Map<string, string | null>): string => {
  switch (node.type) {
    case "text":
    case "html":
      return nameMentions(node.value, names);
    case "inlineCode":
    case "code":
      return node.value;
    case "break":
      return "\n";
    case "image":
      return node.alt ?? "";
    default:
      return "children" in node
        ? node.children.map((c) => inlineText(c, names)).join("")
        : "";
  }
};

const blockText = (node: Nodes, names: Map<string, string | null>): string => {
  if (!BLOCKS.has(node.type) || !("children" in node))
    return inlineText(node, names);
  const joined = node.children
    .map((c) => blockText(c, names))
    .filter((s) => s !== "")
    .join("\n");
  if (node.type === "listItem" && typeof node.checked === "boolean") {
    return `${node.checked ? "[x]" : "[ ]"} ${joined}`;
  }
  return joined;
};

/** `tree` is `parseBody(markdown)`, passed when it is already parsed. */
export const plainText = (
  markdown: string,
  names: Map<string, string | null>,
  tree: Root | null = parseBody(markdown)
): string =>
  (tree ? blockText(tree, names) : nameMentions(markdown, names))
    .trim()
    .slice(0, BODY_TEXT_LIMIT);
