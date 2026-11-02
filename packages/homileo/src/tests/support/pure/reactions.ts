import type { ReactionSummary } from "@homileo-io/sdk";

interface EventLike {
  type: string;
  payload: {
    message?: { id: string; reactions: unknown; reactionSeq: unknown };
    messageId?: string;
    reactions?: unknown;
    reactionSeq?: unknown;
  };
}

/** The `reactions` and `reactionSeq` an event states for `messageId`, if any. */
const summaryOf = (
  e: EventLike,
  messageId: string
): { reactions: ReactionSummary[]; reactionSeq: number } | null => {
  const source =
    e.payload.message?.id === messageId
      ? e.payload.message
      : e.payload.messageId === messageId
        ? e.payload
        : null;
  if (!source) return null;
  return {
    reactions: source.reactions as ReactionSummary[],
    reactionSeq: source.reactionSeq as number,
  };
};

/**
 * The documented client rule (docs/realtime.md): start from `initial`, and take a message
 * view's or reaction event's summary only when its `reactionSeq` is above the one held.
 */
export const reactionsAfter = (
  events: EventLike[],
  messageId: string,
  initial: { reactions: ReactionSummary[]; reactionSeq: number } = {
    reactions: [],
    reactionSeq: -1,
  }
) => {
  let held = initial;
  for (const e of events) {
    const seen = summaryOf(e, messageId);
    if (seen && seen.reactionSeq > held.reactionSeq) held = seen;
  }
  return held;
};

/** Every order of `items`. */
export const permutations = <T>(items: T[]): T[][] =>
  items.length <= 1
    ? [items]
    : items.flatMap((item, i) =>
        permutations([...items.slice(0, i), ...items.slice(i + 1)]).map(
          (rest) => [item, ...rest]
        )
      );
