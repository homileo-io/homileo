import { resolveKind } from "../../definitions/builtins.js";
import { invalidateKinds } from "../kinds.js";
import { validateSet } from "./validate.js";
import { prisma } from "../db/prisma.js";
import { db } from "../db/index.js";
import env from "../../env.js";
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

// Runs once at start, and may wait out the requests in flight that use a kind
// or type it retires, each bounded by DB_TRANSACTION_TIMEOUT_MS.
const APPLY_TIMEOUT_MS = Math.max(60_000, 2 * env.DB_TRANSACTION_TIMEOUT_MS);

// Prisma's timeout only abandons the transaction on the client: a lock wait
// already on the server holds the connection until lock_timeout ends it.
const LOCK_TIMEOUT_MARGIN_MS = 1_000;

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
  documents: LoadedDocument[],
  options: { timeoutMs?: number } = {}
): Promise<ProvisioningResult> => {
  const invalid = validateSet(documents);
  if (invalid.length > 0) throw new ProvisioningError(invalid);
  const timeout = options.timeoutMs ?? APPLY_TIMEOUT_MS;
  const lockTimeout = Math.max(1, Math.floor(timeout - LOCK_TIMEOUT_MARGIN_MS));

  const result = await prisma.$transaction(
    async (tx) => {
      // SET takes no parameters; the value is an integer computed above.
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = ${lockTimeout}`);
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
      const searchChanged: string[] = [];

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
          // Order matters too: it is the order of the words in search_text.
          if (
            !found ||
            canonical(found.definition.search?.metadata ?? []) !==
              canonical(definition.search.metadata)
          ) {
            searchChanged.push(declaration.name);
          }
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

      // In name order, so two replicas starting at once take the locks alike.
      const byName = <R extends { name: string }>(rows: Iterable<R>) =>
        [...rows].sort((a, b) =>
          a.name < b.name ? -1 : a.name > b.name ? 1 : 0
        );

      for (const row of byName(existingKinds.values())) {
        if (row.retired || declaredKinds.has(row.name)) continue;
        // Waits for any space create in flight in the kind, and holds off new ones.
        await db.provisioned.holdExclusive(tx, "kind", row.name);
        if (await db.provisioned.hasUnarchivedSpaces(tx, row.name)) {
          problems.push({
            file: row.sourceFile,
            path: row.name,
            message: `kind "${row.name}" was removed but still has unarchived spaces; archive them first`,
          });
          continue;
        }
        await db.provisioned.retireKind(tx, row.name);
        retired.push(row.name);
      }

      for (const row of byName(existingTypes.values())) {
        if (row.retired || declaredTypes.has(row.name)) continue;
        // Waits for any send or edit in flight with the type, and holds off new ones.
        await db.provisioned.holdExclusive(tx, "message_type", row.name);
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
      // Last, so the stamp is later than any space written under the old keys.
      await db.provisioned.markSearchChanged(tx, searchChanged);
      return { applied, retired };
    },
    { timeout }
  );
  invalidateKinds();
  return result;
};
