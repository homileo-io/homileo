import { mentionReaders, type SessionContext } from "./access.js";
import type { MentionedPrincipal } from "./db/messages.js";
import type { Prisma } from "./db/prisma.js";
import { parseMentions } from "./mentions.js";
import { IdSchema } from "./idSchema.js";
import { plainText } from "./markdown.js";
import { db } from "./db/index.js";

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

/**
 * What a message body's mentions mean in this session: its `body_text`, the
 * readers to store, and the `<!here>` / `<!session>` flags.
 */
export const resolveMentions = async (
  tx: Prisma.TransactionClient,
  context: SessionContext,
  body: string | undefined | null
): Promise<ResolvedMentions> => {
  if (body === undefined || body === null) {
    return { bodyText: null, readers: [], here: false, session: false };
  }
  const parsed = parseMentions(body);
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
    bodyText: plainText(body, names),
    readers: mentionReaders(
      context,
      mentioned.filter((p) => mentionable.has(p.id))
    ),
    here: parsed.here,
    session: parsed.session,
  };
};
