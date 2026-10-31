import { v7 as uuidv7 } from "uuid";

/**
 * Test tokens, as tereo's SDK test mode reads them: the user id, then `|`
 * separated fields. `org: null` is a token without an organization.
 */
export const personToken = (o: {
  userId?: string;
  org: string | null;
  perms?: string[];
}): string =>
  `test-token-${o.userId ?? uuidv7()}${o.org ? `|org=${o.org}` : ""}${
    o.perms?.length ? `|perms=${o.perms.join(",")}` : ""
  }`;

/** A service account's token: its client id is its user id. */
export const botToken = (o: {
  userId?: string;
  org: string | null;
}): string => {
  const id = o.userId ?? uuidv7();
  return `test-token-${id}|client=${id}${o.org ? `|org=${o.org}` : ""}`;
};
