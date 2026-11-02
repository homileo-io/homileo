import type { ResolvedSpaceKind } from "../../definitions/builtins.js";
import { prisma, type Prisma } from "./prisma.js";

type Tx = Prisma.TransactionClient;

export interface KindRow {
  name: string;
  app: string;
  definition: ResolvedSpaceKind;
  documentVersion: string;
  sourceFile: string;
  retired: boolean;
}

export interface TypeRow {
  name: string;
  app: string;
  payloadSchema: object;
  documentVersion: string;
  sourceFile: string;
  retired: boolean;
}

export const listKinds = async (tx: Tx = prisma): Promise<KindRow[]> =>
  (await tx.provisionedSpaceKind.findMany()).map((row) => ({
    name: row.name,
    app: row.app,
    definition: row.definition as unknown as ResolvedSpaceKind,
    documentVersion: row.documentVersion,
    sourceFile: row.sourceFile,
    retired: row.retiredAt !== null,
  }));

export const listTypes = async (tx: Tx = prisma): Promise<TypeRow[]> =>
  (await tx.provisionedMessageType.findMany()).map((row) => ({
    name: row.name,
    app: row.app,
    payloadSchema: row.payloadSchema as object,
    documentVersion: row.documentVersion,
    sourceFile: row.sourceFile,
    retired: row.retiredAt !== null,
  }));

export const activeKinds = async (): Promise<ResolvedSpaceKind[]> =>
  (
    await prisma.provisionedSpaceKind.findMany({ where: { retiredAt: null } })
  ).map((row) => row.definition as unknown as ResolvedSpaceKind);

export const upsertKind = async (
  tx: Tx,
  row: Omit<KindRow, "retired">
): Promise<void> => {
  const data = {
    app: row.app,
    definition: row.definition as unknown as Prisma.InputJsonValue,
    documentVersion: row.documentVersion,
    sourceFile: row.sourceFile,
    retiredAt: null,
  };
  await tx.provisionedSpaceKind.upsert({
    where: { name: row.name },
    create: { name: row.name, ...data },
    update: data,
  });
};

export const upsertType = async (
  tx: Tx,
  row: Omit<TypeRow, "retired">
): Promise<void> => {
  const data = {
    app: row.app,
    payloadSchema: row.payloadSchema as Prisma.InputJsonValue,
    documentVersion: row.documentVersion,
    sourceFile: row.sourceFile,
    retiredAt: null,
  };
  await tx.provisionedMessageType.upsert({
    where: { name: row.name },
    create: { name: row.name, ...data },
    update: data,
  });
};

export const retireKind = async (tx: Tx, name: string): Promise<void> => {
  await tx.provisionedSpaceKind.update({
    where: { name },
    data: { retiredAt: new Date() },
  });
};

export const retireType = async (tx: Tx, name: string): Promise<void> => {
  await tx.provisionedMessageType.update({
    where: { name },
    data: { retiredAt: new Date() },
  });
};

/*
 * Using a kind or message type (creating a space, storing a payload) holds a
 * shared transaction-level advisory lock on it; retiring one takes it
 * exclusive first, so the use and the retirement's "in use?" check never
 * interleave, on any replica. Unlike FOR SHARE on the row, a shared advisory
 * lock writes nothing, so busy types make no MultiXact churn.
 *
 * Key: hashtextextended('homileo.<kind|message_type>:<name>', 0), a bigint. A
 * collision only makes two names wait on each other. Nothing else in Homileo
 * takes advisory locks. Lock order: a use takes one key after its row locks
 * (space, session); provisioning takes keys in name order and no space or
 * session row locks.
 */
type Provisioned = "kind" | "message_type";

const advisoryKey = (what: Provisioned, name: string) =>
  `homileo.${what}:${name}`;

export const holdShared = async (
  tx: Tx,
  what: Provisioned,
  name: string
): Promise<void> => {
  await tx.$queryRaw`
    SELECT 1 AS held
    FROM pg_advisory_xact_lock_shared(hashtextextended(${advisoryKey(what, name)}, 0))`;
};

export const holdExclusive = async (
  tx: Tx,
  what: Provisioned,
  name: string
): Promise<void> => {
  await tx.$queryRaw`
    SELECT 1 AS held
    FROM pg_advisory_xact_lock(hashtextextended(${advisoryKey(what, name)}, 0))`;
};

// Served by the partial spaces_kind_unarchived_idx.
export const hasUnarchivedSpaces = async (
  tx: Tx,
  kind: string
): Promise<boolean> =>
  (
    await tx.$queryRaw<unknown[]>`
      SELECT 1 FROM "chat"."spaces"
      WHERE kind = ${kind} AND archived_at IS NULL
      LIMIT 1`
  ).length > 0;

// The literal `type <> 'text'` lets even a generic plan use the partial
// messages_type_idx.
export const messageUses = async (tx: Tx, type: string): Promise<boolean> =>
  (
    await tx.$queryRaw<unknown[]>`
      SELECT 1 FROM "chat"."messages"
      WHERE type = ${type} AND type <> 'text'
      LIMIT 1`
  ).length > 0;
