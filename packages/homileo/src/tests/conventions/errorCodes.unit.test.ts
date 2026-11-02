// @module-tag unit
// @module-tag platform
import { readdirSync, readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "url";
import ts from "typescript";
import path from "path";

// Every error code the HTTP API can answer with is in docs/api.md's error
// table, under the status it answers with; every socket code is in
// docs/realtime.md. Codes and statuses are read from the source: each
// AppError construction resolved through its class's constructor down to
// AppError, the helpers that take a code and throw with it
// (`mapUniqueViolation`), the `{ status, code }` literals of utils/errors.ts's
// own mapping and the library codes it passes through.
const SRC = fileURLToPath(new URL("../..", import.meta.url));
const ERRORS_FILE = path.join(SRC, "utils/errors.ts");
const DOCS = fileURLToPath(new URL("../../../docs/", import.meta.url));
const CODE = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$|^[a-z]+$/;

interface Pair {
  status: number | undefined;
  code: string;
  at: string;
}

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

const where = (n: ts.Node) => {
  const file = n.getSourceFile();
  const { line } = file.getLineAndCharacterOfPosition(n.getStart());
  return `${path.relative(SRC, file.fileName)}:${line + 1}`;
};

const sourceFiles = (dir: string): string[] =>
  readdirSync(path.join(SRC, dir), { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))
    .map((f) => path.join(SRC, dir, f));

const apiSourceFiles = (): string[] =>
  sourceFiles(".").filter(
    (f) => !/^(tests|websocket)\//.test(path.relative(SRC, f))
  );

const errorsFile = parse(ERRORS_FILE);

const errorClasses = new Map<string, ts.ClassDeclaration>();
walk(errorsFile, (n) => {
  if (ts.isClassDeclaration(n) && n.name) errorClasses.set(n.name.text, n);
});

/** What a construction comes to: a status if it is a literal, and the code expression. */
interface Resolved {
  status: number | undefined;
  code: ts.Expression | undefined;
}

const numberOf = (e: ts.Expression | undefined) =>
  e && ts.isNumericLiteral(e) ? Number(e.text) : undefined;

/** Follows `new <cls>(args)` through each constructor's `super(...)` to AppError's (status, code). */
const resolveConstruction = (
  cls: string,
  args: readonly (ts.Expression | undefined)[]
): Resolved => {
  if (cls === "AppError") return { status: numberOf(args[0]), code: args[1] };
  const decl = errorClasses.get(cls)!;
  const parent = decl.heritageClauses?.[0]?.types[0]?.expression.getText();
  const ctor = decl.members.find(ts.isConstructorDeclaration);
  if (!ctor) return resolveConstruction(parent!, args);

  const bound = new Map<string, ts.Expression | undefined>();
  ctor.parameters.forEach((p, i) =>
    bound.set(p.name.getText(), args[i] ?? p.initializer)
  );
  let superArgs: (ts.Expression | undefined)[] = [];
  walk(ctor, (n) => {
    if (
      ts.isCallExpression(n) &&
      n.expression.kind === ts.SyntaxKind.SuperKeyword
    ) {
      superArgs = n.arguments.map((a) =>
        ts.isIdentifier(a) && bound.has(a.text) ? bound.get(a.text) : a
      );
    }
  });
  return resolveConstruction(parent!, superArgs);
};

/** The name and parameters of the function `n` is in. */
const enclosingFunction = (
  n: ts.Node
): { name: string; params: string[] } | null => {
  for (let p = n.parent; p; p = p.parent) {
    if (
      ts.isFunctionDeclaration(p) ||
      ts.isArrowFunction(p) ||
      ts.isFunctionExpression(p)
    ) {
      const name =
        p.name?.getText() ??
        (ts.isVariableDeclaration(p.parent) ? p.parent.name.getText() : null);
      if (!name) return null;
      return { name, params: p.parameters.map((q) => q.name.getText()) };
    }
  }
  return null;
};

/** A function that throws an AppError with the code it is given: its name, the code's index and the status. */
interface Helper {
  name: string;
  index: number;
  status: number | undefined;
}

const restPairs = (): { pairs: Pair[]; helpers: Helper[] } => {
  const pairs: Pair[] = [];
  const helpers: Helper[] = [];
  const files = apiSourceFiles().map(parse);
  for (const file of files) {
    walk(file, (n) => {
      if (
        !ts.isNewExpression(n) ||
        !ts.isIdentifier(n.expression) ||
        !errorClasses.has(n.expression.text)
      ) {
        return;
      }
      const { status, code } = resolveConstruction(
        n.expression.text,
        n.arguments ?? []
      );
      if (code && ts.isStringLiteral(code)) {
        pairs.push({ status, code: code.text, at: where(n) });
      } else if (code && ts.isIdentifier(code)) {
        const fn = enclosingFunction(n);
        const index = fn?.params.indexOf(code.text) ?? -1;
        if (fn && index >= 0) helpers.push({ name: fn.name, index, status });
      }
    });
  }
  for (const file of files) {
    walk(file, (n) => {
      if (!ts.isCallExpression(n) || !ts.isIdentifier(n.expression)) return;
      const callee = n.expression.text;
      for (const helper of helpers.filter((h) => h.name === callee)) {
        const arg = n.arguments[helper.index];
        if (arg && ts.isStringLiteral(arg)) {
          pairs.push({ status: helper.status, code: arg.text, at: where(n) });
        }
      }
    });
  }

  walk(errorsFile, (n) => {
    if (!ts.isObjectLiteralExpression(n)) return;
    const prop = (name: string) =>
      n.properties.find(
        (p): p is ts.PropertyAssignment =>
          ts.isPropertyAssignment(p) && p.name.getText() === name
      )?.initializer;
    const code = prop("code");
    if (code && ts.isStringLiteral(code)) {
      pairs.push({
        status: numberOf(prop("status")),
        code: code.text,
        at: where(n),
      });
    }
  });
  walk(errorsFile, (n) => {
    if (
      ts.isVariableDeclaration(n) &&
      n.name.getText() === "LIBRARY_ERROR_STATUS" &&
      n.initializer &&
      ts.isObjectLiteralExpression(n.initializer)
    ) {
      for (const p of n.initializer.properties) {
        if (ts.isPropertyAssignment(p)) {
          pairs.push({
            status: numberOf(p.initializer),
            code: p.name.getText(),
            at: where(p),
          });
        }
      }
    }
  });
  return { pairs, helpers };
};

/** docs/api.md's error table: each code and the statuses it is listed under. */
const documentedStatuses = (): Map<string, Set<number>> => {
  const doc = readFileSync(path.join(DOCS, "api.md"), "utf8");
  const from = doc.slice(doc.indexOf("## Errors"));
  const section = from.slice(0, from.indexOf("\n## ", 1));
  const documented = new Map<string, Set<number>>();
  for (const [, status, codes] of section.matchAll(/^\| (\d{3}) \|(.*)\|$/gm)) {
    for (const [, code] of codes.matchAll(/`([a-z_]+)`/g)) {
      if (!documented.has(code)) documented.set(code, new Set());
      documented.get(code)!.add(Number(status));
    }
  }
  return documented;
};

/** Every function in the source by name, for following calls; a name defined twice is not followed. */
const functionsByName = (() => {
  const found = new Map<string, ts.Node[]>();
  for (const file of sourceFiles(".")
    .filter((f) => !path.relative(SRC, f).startsWith("tests/"))
    .map(parse)) {
    walk(file, (n) => {
      let name: string | undefined;
      if (ts.isFunctionDeclaration(n) && n.name) name = n.name.text;
      if (
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.initializer &&
        (ts.isArrowFunction(n.initializer) ||
          ts.isFunctionExpression(n.initializer))
      ) {
        name = n.name.text;
      }
      if (name) found.set(name, [...(found.get(name) ?? []), n]);
    });
  }
  return found;
})();

const calleeName = (call: ts.CallExpression): string | null => {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return null;
};

/** The AppError codes `node` can throw: its own constructions and those of the functions it calls, followed by name. */
const codesThrownBy = (node: ts.Node, seen = new Set<ts.Node>()): Pair[] => {
  const pairs: Pair[] = [];
  walk(node, (n) => {
    if (
      ts.isNewExpression(n) &&
      ts.isIdentifier(n.expression) &&
      errorClasses.has(n.expression.text)
    ) {
      const { status, code } = resolveConstruction(
        n.expression.text,
        n.arguments ?? []
      );
      if (code && ts.isStringLiteral(code)) {
        pairs.push({ status, code: code.text, at: where(n) });
      }
    }
    if (ts.isCallExpression(n)) {
      const name = calleeName(n);
      const defs = name ? functionsByName.get(name) : undefined;
      if (defs?.length === 1 && !seen.has(defs[0])) {
        seen.add(defs[0]);
        pairs.push(...codesThrownBy(defs[0], seen));
      }
    }
  });
  return pairs;
};

/** The code-shaped string literals a function returns, as `failureCode` does. */
const codesReturnedBy = (name: string): string[] => {
  const defs = functionsByName.get(name) ?? [];
  const codes: string[] = [];
  for (const def of defs) {
    walk(def, (n) => {
      if (ts.isStringLiteral(n) && CODE.test(n.text)) codes.push(n.text);
    });
  }
  return codes;
};

/** The try block whose catch clause holds `n`. */
const tryOfCatch = (n: ts.Node): ts.Block | null => {
  for (let p = n.parent; p; p = p.parent) {
    if (ts.isCatchClause(p) && ts.isTryStatement(p.parent)) {
      return p.parent.tryBlock;
    }
  }
  return null;
};

/**
 * The codes a handshake refusal `next(new Error(<code>))` can carry: a literal; `err.code` in a
 * catch, which is any AppError code its try block can throw; or a call such as `failureCode(err)`,
 * whose returned literals count.
 */
const handshakeCodes = (arg: ts.Expression): Pair[] => {
  if (ts.isStringLiteral(arg)) {
    return CODE.test(arg.text)
      ? [{ status: undefined, code: arg.text, at: where(arg) }]
      : [];
  }
  if (ts.isPropertyAccessExpression(arg) && arg.name.text === "code") {
    const block = tryOfCatch(arg);
    if (!block) throw new Error(`${where(arg)}: a code read outside a catch`);
    return codesThrownBy(block).map((p) => ({ ...p, at: where(arg) }));
  }
  if (ts.isCallExpression(arg) && ts.isIdentifier(arg.expression)) {
    return codesReturnedBy(arg.expression.text).map((code) => ({
      status: undefined,
      code,
      at: where(arg),
    }));
  }
  throw new Error(`${where(arg)}: a handshake code this test cannot follow`);
};

const socketCodes = (): Pair[] => {
  const pairs: Pair[] = [];
  for (const file of sourceFiles("websocket").map(parse)) {
    walk(file, (n) => {
      if (
        ts.isPropertyAssignment(n) &&
        n.name.getText() === "code" &&
        ts.isStringLiteral(n.initializer)
      ) {
        pairs.push({
          status: undefined,
          code: n.initializer.text,
          at: where(n),
        });
      }
      // A handshake refusal: `next(new Error(<code>))`.
      if (
        ts.isCallExpression(n) &&
        n.expression.getText() === "next" &&
        n.arguments.length === 1
      ) {
        const arg = n.arguments[0];
        if (
          ts.isNewExpression(arg) &&
          arg.expression.getText() === "Error" &&
          arg.arguments?.[0]
        ) {
          pairs.push(
            ...handshakeCodes(arg.arguments[0]).map((p) => ({
              ...p,
              status: undefined,
            }))
          );
        }
      }
    });
  }
  return pairs;
};

/** The codes realtime.md lists: the handshake's refusals and the acks' codes. */
const documentedSocketCodes = (): Set<string> => {
  const doc = readFileSync(path.join(DOCS, "realtime.md"), "utf8");
  const section = (heading: string) => {
    const from = doc.slice(doc.indexOf(`## ${heading}`));
    return from.slice(0, from.indexOf("\n## ", 1));
  };
  const refusals = section("Connecting")
    .split("\n- ")
    .filter((bullet) => bullet.includes("connect_error"));
  const acks = section("Client events")
    .split("\n\n")
    .filter((paragraph) => paragraph.includes("Codes:"));
  const listed = [...refusals, ...acks].join("\n");
  return new Set([...listed.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]));
};

const describePair = ({ status, code, at }: Pair) =>
  `${status ?? "?"} ${code} (${at})`;

describe("error codes", () => {
  const { pairs, helpers } = restPairs();

  it("finds the codes it should", () => {
    const codes = pairs.map((p) => p.code);
    for (const code of [
      "invalid_request",
      "organization_required",
      "unauthorized",
      "not_found",
      "conflict",
      "version_conflict",
      "payload_too_large",
      "server_error",
      "temporarily_unavailable",
      "resource_archived",
      "duplicate_client_message",
      "external_ref_taken",
      "last_owner",
      "already_member",
    ]) {
      expect(codes).toContain(code);
    }
    expect(helpers.map((h) => h.name)).toContain("mapUniqueViolation");
    expect(socketCodes().map((p) => p.code)).toEqual(
      expect.arrayContaining([
        "rate_limited",
        "unauthorized",
        "not_found",
        // Through `next(new Error(err.code))` and `failureCode(err)` in websocket/auth.ts.
        "organization_required",
        "temporarily_unavailable",
      ])
    );
  });

  it("resolves a status for every HTTP code", () => {
    expect(
      pairs.filter((p) => p.status === undefined).map(describePair)
    ).toEqual([]);
  });

  it("lists every code the API answers with in docs/api.md's error table, under its status", () => {
    const documented = documentedStatuses();
    const wrong = pairs.filter(
      (p) => p.status !== undefined && !documented.get(p.code)?.has(p.status)
    );

    expect(wrong.map(describePair)).toEqual([]);
  });

  it("lists every socket code in docs/realtime.md", () => {
    const documented = documentedSocketCodes();
    const missing = socketCodes().filter((p) => !documented.has(p.code));

    expect(missing.map(describePair)).toEqual([]);
  });
});
