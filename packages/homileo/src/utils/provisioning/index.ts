import { applyDocuments, type ProvisioningResult } from "./apply.js";
import { loadDocuments } from "./load.js";
import { logger } from "../logger.js";
import { db } from "../db/index.js";
import env from "../../env.js";
import {
  BUILTIN_KIND,
  type ResolvedSpaceKind,
} from "../../definitions/builtins.js";

export { ProvisioningError, type Problem } from "./load.js";
export type { ProvisioningResult } from "./apply.js";

/**
 * Applies the documents at `options.path`, or at `PROVISIONING_PATH`. With
 * neither set, nothing is read and nothing changes.
 */
export const provision = async (
  options: { path?: string } = {}
): Promise<ProvisioningResult> => {
  const path = options.path ?? env.PROVISIONING_PATH;
  if (!path) return { applied: 0, retired: [] };

  const documents = await loadDocuments(path);
  const result = await applyDocuments(documents);
  const changed = result.applied > 0 || result.retired.length > 0;
  logger.info(
    {
      documents: documents.map((d) => ({
        file: d.file,
        app: d.document.app,
        version: d.document.version,
      })),
      ...(changed && result),
    },
    changed ? "Applied the provisioning documents" : "Provisioning unchanged"
  );
  return result;
};

/** The active kinds by name, with the built-in one. */
export const loadKinds = async (): Promise<Map<string, ResolvedSpaceKind>> => {
  const kinds = new Map<string, ResolvedSpaceKind>([
    [BUILTIN_KIND.name, BUILTIN_KIND],
  ]);
  for (const kind of await db.provisioned.activeKinds())
    kinds.set(kind.name, kind);
  return kinds;
};
