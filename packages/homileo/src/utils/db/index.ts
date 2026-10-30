/**
 * One object across all tables. Each table's module is added here as it is
 * written, so callers write `db.principals.upsertByTereoUser(...)`.
 */
export const db = {};

export { prisma } from "./prisma.js";
export type { Prisma } from "./prisma.js";
