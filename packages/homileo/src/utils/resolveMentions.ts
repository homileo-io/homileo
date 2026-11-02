import { parseMentions, type ParsedMentions } from "./mentions.js";
import { mentionReaders, type SessionContext } from "./access.js";
import type { MentionedPrincipal } from "./db/messages.js";
import { parseBody, plainText } from "./markdown.js";
import type { Prisma } from "./db/prisma.js";
import { IdSchema } from "./idSchema.js";
import { db } from "./db/index.js";
import type { Root } from "mdast";

/** Distinct user mentions per message, in order of appearance; later ones stay text. */
export const USER_MENTIONS_MAX = 100;

export interface ResolvedMentions {
  /** `null` when there is no body. */
  bodyText: string | null;
  /** The mentioned principals who read the session: the ones whose rows are stored and who may be notified. */
  readers: MentionedPrincipal[];
  here: boolean;
  session: boolean;
}

export interface ReadBody {
  body: string;
  tree: Root | null;
  mentions: ParsedMentions;
}

/** Parses a message body; called before the transaction, so no row lock waits on it. */
export const readBody = (body: string | undefined | null): ReadBody | null => {
  if (body === undefined || body === null) return null;
  const tree = parseBody(body);
  return { body, tree, mentions: parseMentions(body, tree) };
};

/**
 * What a message body's mentions mean in this session: its `body_text`, the
 * readers to store, and the `<!here>` / `<!session>` flags.
 */
export const resolveMentions = async (
  tx: Prisma.TransactionClient,
  context: SessionContext,
  read: ReadBody | null
): Promise<ResolvedMentions> => {
  if (read === null) {
    return { bodyText: null, readers: [], here: false, session: false };
  }
  const parsed = read.mentions;
  // A token of 36 hex digits and hyphens in the wrong places is not an id: it stays text.
  const ids = parsed.users.filter((id) => IdSchema.safeParse(id).success);
  const mentionable = new Set(ids.slice(0, USER_MENTIONS_MAX));
  const mentioned = await db.messages.mentionedPrincipals(
    tx,
    context.session,
    ids
  );
  const names = new Map(mentioned.map((p) => [p.id, p.displayName]));
  return {
    bodyText: plainText(read.body, names, read.tree),
    readers: mentionReaders(
      context,
      mentioned.filter((p) => mentionable.has(p.id))
    ),
    here: parsed.here,
    session: parsed.session,
  };
};
