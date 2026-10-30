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

export const countUnarchivedSpaces = (tx: Tx, kind: string): Promise<number> =>
  tx.space.count({ where: { kind, archivedAt: null } });

export const messageUses = async (tx: Tx, type: string): Promise<boolean> =>
  (await tx.message.findFirst({ where: { type }, select: { id: true } })) !==
  null;
