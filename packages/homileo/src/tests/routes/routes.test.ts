// @module-tag int
// @module-tag platform
import { collectRoutes } from "../support/routeTable.js";
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";
import { parse } from "yaml";
import path from "path";

const BUNDLE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../openapi/bundled-openapi.yaml"
);
const OPERATIONS = ["get", "post", "put", "patch", "delete", "head"];

const openApiPath = (route: string) => route.replace(/[:*](\w+)/g, "{$1}");

const mounted = new Set(
  (await collectRoutes()).map(
    ({ method, path: p }) => `${method} ${openApiPath(p)}`
  )
);

const documented = new Set(
  Object.entries(
    (parse(readFileSync(BUNDLE, "utf8")) as { paths: Record<string, object> })
      .paths
  ).flatMap(([p, item]) =>
    Object.keys(item)
      .filter((key) => OPERATIONS.includes(key))
      .map((method) => `${method} ${p}`)
  )
);

describe("OpenAPI coverage", () => {
  it("every mounted route has an OpenAPI operation", () => {
    expect([...mounted].filter((r) => !documented.has(r))).toEqual([]);
  });

  it("every OpenAPI operation has a mounted route", () => {
    expect([...documented].filter((r) => !mounted.has(r))).toEqual([]);
  });

  it("documents /health and /v1/me", () => {
    expect(documented.has("get /health")).toBe(true);
    expect(documented.has("get /v1/me")).toBe(true);
  });
});
