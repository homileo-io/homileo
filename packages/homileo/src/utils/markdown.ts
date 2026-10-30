import { gfmAutolinkLiteralFromMarkdown } from "mdast-util-gfm-autolink-literal";
import { gfmAutolinkLiteral } from "micromark-extension-gfm-autolink-literal";
import { gfmStrikethroughFromMarkdown } from "mdast-util-gfm-strikethrough";
import { gfmTaskListItemFromMarkdown } from "mdast-util-gfm-task-list-item";
import { gfmStrikethrough } from "micromark-extension-gfm-strikethrough";
import { gfmTaskListItem } from "micromark-extension-gfm-task-list-item";
import { fromMarkdown } from "mdast-util-from-markdown";
import type { Nodes, Root } from "mdast";

export const MENTION_PATTERN = /<@([0-9a-f-]{36})>|<!(here|session)>/gi;

export const BODY_TEXT_LIMIT = 40_000;

export const parseMarkdown = (markdown: string): Root =>
  fromMarkdown(markdown, {
    extensions: [gfmStrikethrough(), gfmTaskListItem(), gfmAutolinkLiteral()],
    mdastExtensions: [
      gfmStrikethroughFromMarkdown(),
      gfmTaskListItemFromMarkdown(),
      gfmAutolinkLiteralFromMarkdown(),
    ],
  });

const BLOCKS = new Set(["root", "list", "listItem", "blockquote"]);

const inlineText = (node: Nodes, names: Map<string, string | null>): string => {
  switch (node.type) {
    case "text":
    case "html":
      return node.value.replace(
        MENTION_PATTERN,
        (_m, id: string | undefined, kind: string | undefined) =>
          id
            ? `@${names.get(id.toLowerCase()) ?? "unknown"}`
            : `@${kind!.toLowerCase()}`
      );
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

export const plainText = (
  markdown: string,
  names: Map<string, string | null>
): string =>
  blockText(parseMarkdown(markdown), names).trim().slice(0, BODY_TEXT_LIMIT);
