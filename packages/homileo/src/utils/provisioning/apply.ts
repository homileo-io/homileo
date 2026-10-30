import { resolveKind } from "../../definitions/builtins.js";
import { invalidateKinds } from "../kinds.js";
import { validateSet } from "./validate.js";
import { prisma } from "../db/prisma.js";
import { db } from "../db/index.js";
import {
  ProvisioningError,
  type LoadedDocument,
  type Problem,
} from "./load.js";

export interface ProvisioningResult {
  /** Rows created, changed or re-activated. */
  applied: number;
  retired: string[];
}

// Postgres returns jsonb with its own key order, so values are compared by content.
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        )
      : v
  );

/**
 * Validates the set and writes it in one transaction: declared kinds and
 * message types are created, changed or re-activated, and every active one the
 * documents no longer declare is retired. A kind with unarchived spaces, or a
 * message type some message uses, cannot be retired: that is a problem, and
 * nothing is written.
 */
export const applyDocuments = async (
  documents: LoadedDocument[]
): Promise<ProvisioningResult> => {
  const invalid = validateSet(documents);
  if (invalid.length > 0) throw new ProvisioningError(invalid);

  const result = await prisma.$transaction(async (tx) => {
    const problems: Problem[] = [];
    const retired: string[] = [];
    let applied = 0;

    const existingKinds = new Map(
      (await db.provisioned.listKinds(tx)).map((r) => [r.name, r])
    );
    const existingTypes = new Map(
      (await db.provisioned.listTypes(tx)).map((r) => [r.name, r])
    );
    const declaredKinds = new Set<string>();
    const declaredTypes = new Set<string>();

    for (const { file, document } of documents) {
      const documentVersion = document.version;

      for (const declaration of document.spaceKinds ?? []) {
        declaredKinds.add(declaration.name);
        const definition = resolveKind(declaration);
        const row = {
          name: declaration.name,
          app: document.app,
          definition,
          documentVersion,
          sourceFile: file,
        };
        const found = existingKinds.get(declaration.name);
        const unchanged =
          found &&
          !found.retired &&
          found.app === row.app &&
          found.documentVersion === documentVersion &&
          found.sourceFile === file &&
          canonical(found.definition) === canonical(definition);
        if (unchanged) continue;
        await db.provisioned.upsertKind(tx, row);
        applied++;
      }

      for (const declaration of document.messageTypes ?? []) {
        declaredTypes.add(declaration.name);
        const row = {
          name: declaration.name,
          app: document.app,
          payloadSchema: declaration.payloadSchema,
          documentVersion,
          sourceFile: file,
        };
        const found = existingTypes.get(declaration.name);
        const unchanged =
          found &&
          !found.retired &&
          found.app === row.app &&
          found.documentVersion === documentVersion &&
          found.sourceFile === file &&
          canonical(found.payloadSchema) === canonical(row.payloadSchema);
        if (unchanged) continue;
        await db.provisioned.upsertType(tx, row);
        applied++;
      }
    }

    for (const row of existingKinds.values()) {
      if (row.retired || declaredKinds.has(row.name)) continue;
      // Space creation reads the kind FOR SHARE: holding the row FOR UPDATE
      // makes the count and the retirement wait for any create in flight.
      await db.provisioned.lockKind(tx, row.name);
      const spaces = await db.provisioned.countUnarchivedSpaces(tx, row.name);
      if (spaces > 0) {
        problems.push({
          file: row.sourceFile,
          path: row.name,
          message: `kind "${row.name}" was removed but still has ${spaces} unarchived space${spaces === 1 ? "" : "s"}; archive them first`,
        });
        continue;
      }
      await db.provisioned.retireKind(tx, row.name);
      retired.push(row.name);
    }

    for (const row of existingTypes.values()) {
      if (row.retired || declaredTypes.has(row.name)) continue;
      if (await db.provisioned.messageUses(tx, row.name)) {
        problems.push({
          file: row.sourceFile,
          path: row.name,
          message: `message type "${row.name}" was removed but existing messages use it`,
        });
        continue;
      }
      await db.provisioned.retireType(tx, row.name);
      retired.push(row.name);
    }

    // Throwing rolls the whole transaction back.
    if (problems.length > 0) throw new ProvisioningError(problems);
    return { applied, retired };
  });
  invalidateKinds();
  return result;
};
