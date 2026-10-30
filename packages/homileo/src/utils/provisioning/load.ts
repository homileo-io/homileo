import type { HomileoProvisioningDocument } from "@homileo-io/sdk";
import { provisioningDocumentSchema } from "@homileo-io/sdk";
import { readFile, readdir, stat } from "fs/promises";
import { basename, join } from "path";
import type { z } from "zod";

export interface Problem {
  file: string;
  path: string;
  message: string;
}

export class ProvisioningError extends Error {
  constructor(public problems: Problem[]) {
    super(
      `Invalid provisioning:\n${problems
        .map((p) => `  - ${p.file}${p.path ? ` ${p.path}` : ""}: ${p.message}`)
        .join("\n")}`
    );
    this.name = "ProvisioningError";
  }
}

export interface LoadedDocument {
  file: string;
  document: HomileoProvisioningDocument;
}

/** `spaceKinds[0].name`, or "" for the document itself. */
export const formatPath = (path: ReadonlyArray<PropertyKey>): string =>
  path
    .map((part, i) =>
      typeof part === "number"
        ? `[${part}]`
        : i
          ? `.${String(part)}`
          : String(part)
    )
    .join("");

// Zod's messages describe the rule, not the received value.
const describeIssue = (issue: z.core.$ZodIssue): Problem["message"] =>
  issue.code === "unrecognized_keys"
    ? `unknown key ${issue.keys.map((k) => `"${k}"`).join(", ")}`
    : issue.message;

/**
 * The files of a provisioning path: every `*.json` directly inside a
 * directory, in name order (dotfiles, other extensions and subdirectories are
 * skipped), or the one file a file path names.
 */
export const readProvisioningPath = async (
  path: string
): Promise<{ file: string; text: string }[]> => {
  const unreadable = (err: unknown): never => {
    const code = (err as NodeJS.ErrnoException).code ?? "error";
    throw new ProvisioningError([
      {
        file: path,
        path: "",
        message: `cannot read PROVISIONING_PATH: ${code}`,
      },
    ]);
  };

  let info;
  try {
    info = await stat(path);
  } catch (err) {
    return unreadable(err);
  }

  if (!info.isDirectory()) {
    try {
      return [{ file: basename(path), text: await readFile(path, "utf8") }];
    } catch (err) {
      return unreadable(err);
    }
  }

  let names: string[];
  try {
    names = await readdir(path);
  } catch (err) {
    return unreadable(err);
  }

  const files: { file: string; text: string }[] = [];
  for (const name of names.sort()) {
    if (name.startsWith(".") || !name.endsWith(".json")) continue;
    // stat follows links: a mounted ConfigMap's entries are symlinks.
    try {
      if (!(await stat(join(path, name))).isFile()) continue;
      files.push({
        file: name,
        text: await readFile(join(path, name), "utf8"),
      });
    } catch (err) {
      return unreadable(err);
    }
  }
  if (files.length === 0)
    throw new ProvisioningError([
      { file: path, path: "", message: "no provisioning documents" },
    ]);
  return files;
};

const jsonSyntaxProblem = (err: unknown): string => {
  // The message can quote the source text; only the position is kept.
  const at = /position (\d+)/.exec(err instanceof Error ? err.message : "");
  return at ? `not valid JSON (at position ${at[1]})` : "not valid JSON";
};

/** Parses every file and reports every problem at once. */
export const parseDocuments = (
  files: { file: string; text: string }[]
): LoadedDocument[] => {
  const problems: Problem[] = [];
  const documents: LoadedDocument[] = [];

  for (const { file, text } of files) {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      problems.push({ file, path: "", message: jsonSyntaxProblem(err) });
      continue;
    }
    const parsed = provisioningDocumentSchema.safeParse(raw);
    if (!parsed.success) {
      for (const issue of parsed.error.issues)
        problems.push({
          file,
          path: formatPath(issue.path),
          message: describeIssue(issue),
        });
      continue;
    }
    documents.push({ file, document: parsed.data });
  }

  if (problems.length > 0) throw new ProvisioningError(problems);
  return documents;
};

export const loadDocuments = async (path: string): Promise<LoadedDocument[]> =>
  parseDocuments(await readProvisioningPath(path));
