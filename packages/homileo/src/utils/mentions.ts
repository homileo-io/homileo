import { MENTION_PATTERN, parseBody } from "./markdown.js";
import type { Nodes, Root } from "mdast";

export interface ParsedMentions {
  users: string[];
  here: boolean;
  session: boolean;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** A body read as plain text, less its fenced code blocks and inline code spans. */
const outsideCode = (markdown: string): string[] => {
  const kept: string[] = [];
  let fence: string | null = null;
  for (const line of markdown.split(/\r\n|\r|\n/)) {
    const [, run, rest] = FENCE.exec(line) ?? [];
    if (fence !== null) {
      if (
        run?.[0] === fence[0] &&
        run.length >= fence.length &&
        rest!.trim() === ""
      ) {
        fence = null;
      }
    } else if (run !== undefined && !(run[0] === "`" && rest!.includes("`"))) {
      fence = run;
    } else {
      kept.push(line.replace(/`[^`]*`/g, ""));
    }
  }
  return kept;
};

/** `tree` is `parseBody(markdown)`, passed when it is already parsed. */
export const parseMentions = (
  markdown: string,
  tree: Root | null = parseBody(markdown)
): ParsedMentions => {
  const users = new Set<string>();
  const found: ParsedMentions = { users: [], here: false, session: false };

  const scan = (text: string): void => {
    for (const m of text.matchAll(MENTION_PATTERN)) {
      if (m[1]) users.add(m[1].toLowerCase());
      else if (m[2]!.toLowerCase() === "here") found.here = true;
      else found.session = true;
    }
  };

  const visit = (node: Nodes): void => {
    if (node.type === "text" || node.type === "html") scan(node.value);
    else if ("children" in node) node.children.forEach(visit);
  };

  if (tree) visit(tree);
  else outsideCode(markdown).forEach(scan);
  found.users = [...users];
  return found;
};
