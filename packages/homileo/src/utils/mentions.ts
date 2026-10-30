import { MENTION_PATTERN, parseMarkdown } from "./markdown.js";
import type { Nodes } from "mdast";

export interface ParsedMentions {
  users: string[];
  here: boolean;
  session: boolean;
}

export const parseMentions = (markdown: string): ParsedMentions => {
  const users = new Set<string>();
  const found: ParsedMentions = { users: [], here: false, session: false };

  const visit = (node: Nodes): void => {
    if (node.type === "text" || node.type === "html") {
      for (const m of node.value.matchAll(MENTION_PATTERN)) {
        if (m[1]) users.add(m[1].toLowerCase());
        else if (m[2]!.toLowerCase() === "here") found.here = true;
        else found.session = true;
      }
    } else if ("children" in node) {
      node.children.forEach(visit);
    }
  };

  visit(parseMarkdown(markdown));
  found.users = [...users];
  return found;
};
