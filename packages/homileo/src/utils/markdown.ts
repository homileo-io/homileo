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

/**
 * Lines of paragraph per unit of work a lazy line costs: micromark walks back
 * over the whole paragraph on each one, so a run of them costs its square.
 */
export const LAZY_LINES_PER_WORK = 10;

const INLINE_MARKUP = new Set(["*", "_", "~", "[", "]"]);
const BLOCK_START = new Set(["#", "=", "-", "`", "~", "*", "_", "<"]);
// `s`: lines may hold U+2028 and U+2029, which `.` does not match.
const FENCE = /^(`{3,}|~{3,})(.*)$/s;
// Only spaces and tabs are whitespace to micromark; `trim()` and `\s` take far more.
const SPACES = /^[ \t]*$/;

const isDigit = (code: number) => code >= 48 && code <= 57;
const endsMarker = (s: string, i: number) =>
  i >= s.length ||
  s[i] === " " ||
  s[i] === "\t" ||
  s[i] === "\n" ||
  s[i] === "\r";

/**
 * Block-quote and list markers opening the line at `i`, the columns of
 * whitespace before and between them (a tab as 4), and where they end.
 */
const lineMarkers = (
  s: string,
  i: number
): [count: number, columns: number, end: number] => {
  let count = 0;
  let columns = 0;
  for (;;) {
    for (; s[i] === " " || s[i] === "\t"; i++) {
      columns += s[i] === "\t" ? 4 : 1;
    }
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
    return [count, columns, i];
  }
};

const lineEnd = (s: string, i: number): number => {
  while (i < s.length && s[i] !== "\n" && s[i] !== "\r") i++;
  return i;
};

export interface Markup {
  /**
   * An upper bound on the constructs that make micromark slow: container
   * markers, lines that may start a heading, fence, thematic break or HTML
   * block, and emphasis, strikethrough, link and image delimiters. The lines
   * of a top-level fenced code block count none.
   */
  count: number;
  /** The most block-quote and list markers opening one line. */
  depth: number;
  /**
   * An upper bound on micromark's container checks and lazy-line walks. Each
   * line counts 1 plus the containers that may be open after it, and a line
   * that may continue a paragraph lazily also counts the paragraph's lines
   * over `LAZY_LINES_PER_WORK`.
   */
  work: number;
}

export const measureMarkup = (markdown: string): Markup => {
  const markup: Markup = { count: 0, depth: 0, work: 0 };
  let open = 0;
  // Non-blank lines since the last blank one: what a lazy line walks back over.
  let paragraph = 0;
  // No paragraph is open: the line cannot be lazy, so it closes any container it does not continue.
  let afterBlank = true;
  // An HTML block can hide a fence line and span blank lines; a definition's title can span lines.
  let mayBeHtml = false;
  let mayBeDefinition = false;
  // The opening run of the top-level fenced code block the line is in.
  let fence: string | null = null;
  // micromark drops a leading byte order mark before it reads line 1.
  let i = markdown.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (i < markdown.length) {
    const [markers, columns, end] = lineMarkers(markdown, i);
    const stop = lineEnd(markdown, end);
    const text = markdown.slice(end, stop);
    i =
      markdown[stop] === "\r" && markdown[stop + 1] === "\n"
        ? stop + 2
        : stop + 1;
    markup.work += 1;

    if (fence !== null) {
      // At the top level only the closing line ends the block.
      const close = markers === 0 && columns <= 3 ? FENCE.exec(text) : null;
      if (
        close &&
        close[1]![0] === fence[0] &&
        close[1]!.length >= fence.length &&
        SPACES.test(close[2]!)
      ) {
        fence = null;
        afterBlank = true;
        markup.count++;
      }
      continue;
    }

    markup.count += markers;
    markup.depth = Math.max(markup.depth, markers);
    // lineMarkers has already passed the line's leading spaces and tabs.
    if (markers === 0 && text === "") {
      markup.work += open;
      paragraph = 0;
      afterBlank = true;
      continue;
    }

    // New containers need markers; a continued list item needs two columns of indent.
    const reach = Math.min(open + markers, markers + Math.floor(columns / 2));
    if (afterBlank) {
      open = reach;
    } else {
      // A line of markers is lazy too when they cannot interrupt a paragraph ("2. b").
      if (open > 0 || markers > 0) {
        markup.work += Math.ceil(paragraph / LAZY_LINES_PER_WORK);
      }
      open = Math.max(open, reach);
    }
    markup.work += open;
    paragraph++;

    if (text[0] === "<") mayBeHtml = true;
    if (text[0] === "[") mayBeDefinition = true;
    const opening =
      open === 0 &&
      columns <= 3 &&
      !mayBeHtml &&
      (afterBlank || !mayBeDefinition)
        ? FENCE.exec(text)
        : null;
    if (opening && !(opening[1]![0] === "`" && opening[2]!.includes("`"))) {
      fence = opening[1]!;
      paragraph = 0;
    }
    afterBlank = false;

    if (BLOCK_START.has(text[0]!)) markup.count++;
    for (let k = 0; k < text.length; k++) {
      if (INLINE_MARKUP.has(text[k]!)) markup.count++;
      else if (text[k] === "!" && text[k + 1] === "[") markup.count++;
    }
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
  if (
    count > PARSE_MAX_MARKUP ||
    depth > PARSE_MAX_DEPTH ||
    work > PARSE_MAX_WORK
  ) {
    return null;
  }
  try {
    return parseMarkdown(markdown);
  } catch (err) {
    // A stack overflow the limits did not foresee: the body is read as plain text.
    if (err instanceof RangeError) return null;
    throw err;
  }
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
