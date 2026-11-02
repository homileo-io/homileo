import { BUILTIN_KIND } from "../definitions/builtins.js";
import type { Prisma } from "./db/prisma.js";
import type { prisma } from "./db/prisma.js";

type Client = Prisma.TransactionClient | typeof prisma;

const leaves = (value: unknown, out: string[]): void => {
  if (value === null || value === undefined) return;
  if (typeof value === "string") out.push(value);
  else if (typeof value === "number" || typeof value === "boolean") {
    out.push(String(value));
  } else if (Array.isArray(value)) {
    for (const item of value) leaves(item, out);
  } else if (typeof value === "object") {
    for (const item of Object.values(value)) leaves(item, out);
  }
};

/** The name, then the scalar leaves of each declared metadata key, joined by single spaces. */
export const searchTextOf = (
  name: string | null,
  metadata: Record<string, unknown>,
  keys: string[]
): string => {
  const parts: string[] = [];
  if (name) parts.push(name);
  for (const key of keys) leaves(metadata[key], parts);
  return parts.join(" ");
};

/**
 * The metadata keys a kind declares for search, read from the database rather than the kind
 * cache; a retired kind still names its keys.
 */
export const searchKeysFor = async (
  client: Client,
  kind: string | null
): Promise<string[]> => {
  if (kind === null || kind === BUILTIN_KIND.name) return [];
  const rows = await client.$queryRaw<Array<{ keys: unknown }>>`
    SELECT definition->'search'->'metadata' AS keys
    FROM "chat"."provisioned_space_kinds"
    WHERE name = ${kind}`;
  const keys = rows[0]?.keys;
  return Array.isArray(keys)
    ? keys.filter((k): k is string => typeof k === "string")
    : [];
};
