import type { ResolvedSpaceKind } from "../../../definitions/builtins.js";
import type { SessionFacts, SpaceFacts } from "../../../policy/index.js";
import { BUILTIN_KIND } from "../../../definitions/builtins.js";
import type { OrgCaller } from "../../../middleware/auth.js";

export const ORG = "00000000-0000-7000-8000-000000000001";
export const OTHER_ORG = "00000000-0000-7000-8000-000000000002";

export const kind = (
  o: Partial<ResolvedSpaceKind> = {}
): ResolvedSpaceKind => ({
  ...BUILTIN_KIND,
  ...o,
});

export const caller = (o: Partial<OrgCaller> = {}): OrgCaller => ({
  principalId: "p-caller",
  tereoUserId: "u-caller",
  isBot: false,
  permissions: [],
  isAdmin: false,
  organizationId: ORG,
  ...o,
});

/** Table rows spell enum values as plain strings, so the overrides are typed loosely. */
export const space = (o: object = {}): SpaceFacts =>
  ({
    organizationId: ORG,
    kind: kind(),
    visibility: "members",
    joinPolicy: "invite",
    postPolicy: "members",
    archived: false,
    role: null,
    ...o,
  }) as SpaceFacts;

export const session = (o: object = {}): SessionFacts =>
  ({
    organizationId: ORG,
    space: space(),
    access: "space",
    archived: false,
    participantRole: null,
    ...o,
  }) as SessionFacts;
