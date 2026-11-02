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

// A token of 36 hex digits and hyphens in the wrong places is not an id: it stays text.
const idsOf = (parsed: ParsedMentions): string[] =>
  parsed.users.filter((id) => IdSchema.safeParse(id).success);

export interface ResolvedMentions {
  /** `null` when there is no body. */
  bodyText: string | null;
  /** Every principal the body mentions, reader or not, for `message_ever_mentions`. */
  mentionedIds: string[];
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
    return {
      bodyText: null,
      mentionedIds: [],
      readers: [],
      here: false,
      session: false,
    };
  }
  const parsed = read.mentions;
  const ids = idsOf(parsed);
  const mentionable = new Set(ids.slice(0, USER_MENTIONS_MAX));
  const mentioned = await db.messages.mentionedPrincipals(
    tx,
    context.session,
    ids
  );
  const names = new Map(mentioned.map((p) => [p.id, p.displayName]));
  const counted = mentioned.filter((p) => mentionable.has(p.id));
  return {
    bodyText: plainText(read.body, names, read.tree),
    mentionedIds: counted.map((p) => p.id),
    readers: mentionReaders(context, counted),
    here: parsed.here,
    session: parsed.session,
  };
};
