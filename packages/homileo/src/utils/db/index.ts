import * as participants from "./participants.js";
import * as provisioned from "./provisioned.js";
import * as principals from "./principals.js";
import * as sessions from "./sessions.js";
import * as messages from "./messages.js";
import * as members from "./members.js";
import * as events from "./events.js";
import * as spaces from "./spaces.js";

/**
 * One object across all tables. Each table's module is added here as it is
 * written, so callers write `db.principals.findOrCreateUser(...)`.
 */
export const db = {
  principals,
  provisioned,
  events,
  spaces,
  sessions,
  members,
  participants,
  messages,
};

export { prisma } from "./prisma.js";
export type { Prisma } from "./prisma.js";
