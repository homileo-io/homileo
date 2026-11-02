// @module-tag unit
// @module-tag platform
import { readdirSync, readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "url";
import ts from "typescript";
import path from "path";

// Every error code the HTTP API can answer with is in docs/api.md's error
// table. Codes are read from the source: the fixed code of each AppError
// subclass that is constructed, the snake_case string arguments of each
// AppError construction, and the `code:` literals of utils/errors.ts's own
// mapping. Sockets (src/websocket) have their own codes, in docs/realtime.md.
const SRC = fileURLToPath(new URL("../..", import.meta.url));
const ERRORS_FILE = path.join(SRC, "utils/errors.ts");
const API_DOC = fileURLToPath(new URL("../../../docs/api.md", import.meta.url));
const CODE = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$|^[a-z]+$/;

const parse = (file: string) =>
  ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true
  );

const walk = (node: ts.Node, visit: (n: ts.Node) => void): void => {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
};

const stringsIn = (node: ts.Node): string[] => {
  const found: string[] = [];
  walk(node, (n) => {
    if (ts.isStringLiteral(n) && CODE.test(n.text)) found.push(n.text);
  });
  return found;
};

/** Each AppError subclass and the codes its constructor names (default parameters and `super` arguments). */
const errorClasses = (): Map<string, string[]> => {
  const classes = new Map<string, string[]>([["AppError", []]]);
  walk(parse(ERRORS_FILE), (n) => {
    if (!ts.isClassDeclaration(n) || !n.name || n.name.text === "AppError")
      return;
    const ctor = n.members.find(ts.isConstructorDeclaration);
    classes.set(n.name.text, ctor ? stringsIn(ctor) : []);
  });
  return classes;
};

const sourceFiles = (): string[] =>
  readdirSync(SRC, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))
    .filter((f) => !/^(tests|websocket)\//.test(f.split(path.sep).join("/")))
    .map((f) => path.join(SRC, f));

const thrownCodes = (): Set<string> => {
  const classes = errorClasses();
  const codes = new Set<string>();
  for (const file of sourceFiles()) {
    walk(parse(file), (n) => {
      if (
        ts.isNewExpression(n) &&
        ts.isIdentifier(n.expression) &&
        classes.has(n.expression.text)
      ) {
        for (const code of classes.get(n.expression.text)!) codes.add(code);
        for (const arg of n.arguments ?? []) {
          if (ts.isStringLiteral(arg) && CODE.test(arg.text))
            codes.add(arg.text);
        }
      }
    });
  }
  walk(parse(ERRORS_FILE), (n) => {
    if (
      ts.isPropertyAssignment(n) &&
      n.name.getText() === "code" &&
      ts.isStringLiteral(n.initializer)
    ) {
      codes.add(n.initializer.text);
    }
  });
  return codes;
};

const documentedCodes = (): Set<string> => {
  const doc = readFileSync(API_DOC, "utf8");
  const table = doc.slice(doc.indexOf("## Errors"));
  const section = table.slice(0, table.indexOf("\n## ", 1));
  return new Set([...section.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]));
};

describe("error codes", () => {
  it("finds the codes it should", () => {
    const codes = thrownCodes();
    for (const code of [
      "invalid_request",
      "organization_required",
      "not_found",
      "conflict",
      "version_conflict",
      "payload_too_large",
      "server_error",
      "temporarily_unavailable",
      "resource_archived",
      "duplicate_client_message",
    ]) {
      expect(codes).toContain(code);
    }
  });

  it("lists every code the API answers with in docs/api.md's error table", () => {
    const documented = documentedCodes();
    const missing = [...thrownCodes()].filter((c) => !documented.has(c));

    expect(missing).toEqual([]);
  });
});
