import type { SpaceKindDeclaration } from "@homileo-io/sdk";

/** A kind with every optional field filled. */
export type ResolvedSpaceKind = Omit<
  Required<SpaceKindDeclaration>,
  "search" | "editWindowSeconds"
> & {
  editWindowSeconds: number | null;
  search: { metadata: string[] };
};

/** The kind of a space that names none. */
export const BUILTIN_KIND: ResolvedSpaceKind = {
  name: "default",
  defaults: { visibility: "members", join: "invite", posting: "members" },
  overridable: ["visibility", "join", "posting"],
  states: [],
  grants: [],
  bots: [],
  editWindowSeconds: null,
  search: { metadata: [] },
};

/** The type of every message that names none. */
export const BUILTIN_MESSAGE_TYPE = "text";

export const resolveKind = (kind: SpaceKindDeclaration): ResolvedSpaceKind => ({
  name: kind.name,
  defaults: kind.defaults,
  overridable: kind.overridable ?? [],
  states: kind.states ?? [],
  grants: kind.grants ?? [],
  bots: kind.bots ?? [],
  editWindowSeconds: kind.editWindowSeconds ?? null,
  search: kind.search ?? { metadata: [] },
});
