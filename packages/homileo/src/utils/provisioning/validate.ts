import type { LoadedDocument, Problem } from "./load.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  BUILTIN_KIND,
  BUILTIN_MESSAGE_TYPE,
} from "../../definitions/builtins.js";

// Payload schemas are the apps' own: unknown keywords and formats are theirs
// to use, so only a schema that cannot be compiled is a problem.
export const createPayloadAjv = () =>
  new Ajv2020({ strict: false, validateFormats: false, allErrors: true });

/** The rules that span documents, and the ones a schema cannot express. Returns every problem. */
export const validateSet = (documents: LoadedDocument[]): Problem[] => {
  const problems: Problem[] = [];
  const ajv = createPayloadAjv();

  const appFiles = new Map<string, string>();
  const kindFiles = new Map<string, string>();
  const typeFiles = new Map<string, string>();

  for (const { file, document } of documents) {
    const firstApp = appFiles.get(document.app);
    if (firstApp !== undefined)
      problems.push({
        file,
        path: "app",
        message: `app "${document.app}" is also declared in ${firstApp}`,
      });
    else appFiles.set(document.app, file);

    (document.spaceKinds ?? []).forEach((kind, i) => {
      const path = `spaceKinds[${i}].name`;
      const first = kindFiles.get(kind.name);
      if (kind.name === BUILTIN_KIND.name)
        problems.push({
          file,
          path,
          message: `"${kind.name}" is the built-in kind and cannot be declared`,
        });
      else if (first !== undefined)
        problems.push({
          file,
          path,
          message: `kind "${kind.name}" is also declared in ${first}`,
        });
      else kindFiles.set(kind.name, file);
    });

    (document.messageTypes ?? []).forEach((type, i) => {
      const path = `messageTypes[${i}]`;
      const first = typeFiles.get(type.name);
      if (type.name === BUILTIN_MESSAGE_TYPE)
        problems.push({
          file,
          path: `${path}.name`,
          message: `"${type.name}" is the built-in message type and cannot be declared`,
        });
      else if (first !== undefined)
        problems.push({
          file,
          path: `${path}.name`,
          message: `message type "${type.name}" is also declared in ${first}`,
        });
      else typeFiles.set(type.name, file);

      try {
        ajv.compile(type.payloadSchema);
      } catch (err) {
        problems.push({
          file,
          path: `${path}.payloadSchema`,
          message: `cannot be compiled: ${err instanceof Error ? err.message : "invalid schema"}`,
        });
      }
    });
  }
  return problems;
};
