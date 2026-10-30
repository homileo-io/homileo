import * as provisioned from "./provisioned.js";
import * as principals from "./principals.js";

/**
 * One object across all tables. Each table's module is added here as it is
 * written, so callers write `db.principals.upsertUser(...)`.
 */
export const db = { principals, provisioned };

export { prisma } from "./prisma.js";
export type { Prisma } from "./prisma.js";
