import type { Event } from "../../../prisma/generated/client/index.js";
import { pgErrorCodes } from "../prismaErrors.js";
import type { Prisma } from "./prisma.js";
import { prisma } from "./prisma.js";
import env from "../../env.js";

export type { Event };

export interface InsertEventInput {
  type: string;
  organizationId: string;
  spaceId: string | null;
  sessionId: string | null;
  actorId: string;
  payload: Prisma.InputJsonValue;
}

/** Appends to the log inside the caller's transaction. */
export const insert = (
  tx: Prisma.TransactionClient,
  input: InsertEventInput
): Promise<Event> => tx.event.create({ data: input });

// A lock not granted in time, and a deadlock: Postgres has rolled the
// transaction back either way and the next run retries.
const RETRY_LATER = ["55P03", "40P01"];

const PARTITION_NAME = /^events_\d{4}_\d{2}_\d{2}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Creating a partition takes ACCESS EXCLUSIVE on `chat.events`. Left to wait
 * behind a long read it would queue every insert behind itself, so it gives up
 * after PARTITION_DDL_LOCK_TIMEOUT_MS. False, with nothing created, when it did.
 */
export const createPartition = async (
  name: string,
  from: string,
  to: string
): Promise<boolean> => {
  // The names are interpolated into DDL, which takes no parameters.
  if (!PARTITION_NAME.test(name) || !DATE.test(from) || !DATE.test(to)) {
    throw new Error(`Invalid partition ${name} [${from}, ${to})`);
  }
  try {
    await prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(
          `SET LOCAL lock_timeout = ${env.PARTITION_DDL_LOCK_TIMEOUT_MS}`
        );
        await tx.$executeRawUnsafe(
          `CREATE TABLE IF NOT EXISTS "chat"."${name}" PARTITION OF "chat"."events" FOR VALUES FROM ('${from}') TO ('${to}')`
        );
      },
      { timeout: 60_000 }
    );
    return true;
  } catch (err) {
    if (pgErrorCodes(err).some((code) => RETRY_LATER.includes(code))) {
      return false;
    }
    throw err;
  }
};
