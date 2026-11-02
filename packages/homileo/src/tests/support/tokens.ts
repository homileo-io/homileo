import { v7 as uuidv7 } from "uuid";

/** What a token holds when a test names no permissions: enough to take part in chat. */
export const DEFAULT_PERMS = ["homileo.spaces.write"];

const permsField = (perms: string[]) =>
  perms.length ? `|perms=${perms.join(",")}` : "";

/**
 * Test tokens, as tereo's SDK test mode reads them: the user id, then `|`
 * separated fields. `org: null` is a token without an organization; `perms: []`
 * is a token without permissions, which every `/v1` route and socket refuses. A
 * list that names only a kind's grant needs `homileo.spaces.read` beside it.
 */
export const personToken = (o: {
  userId?: string;
  org: string | null;
  perms?: string[];
}): string =>
  `test-token-${o.userId ?? uuidv7()}${o.org ? `|org=${o.org}` : ""}${permsField(
    o.perms ?? DEFAULT_PERMS
  )}`;

/** A service account's token: its client id is its user id. */
export const botToken = (o: {
  userId?: string;
  org: string | null;
  perms?: string[];
}): string => {
  const id = o.userId ?? uuidv7();
  return `test-token-${id}|client=${id}${o.org ? `|org=${o.org}` : ""}${permsField(
    o.perms ?? DEFAULT_PERMS
  )}`;
};
