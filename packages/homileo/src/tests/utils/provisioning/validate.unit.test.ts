// @module-tag unit
// @module-tag provisioning
import type { LoadedDocument } from "../../../utils/provisioning/load.js";
import { validateSet } from "../../../utils/provisioning/validate.js";
import { describe, expect, it } from "vitest";

const kind = (name: string) => ({
  name,
  defaults: {
    visibility: "members" as const,
    join: "invite" as const,
    posting: "members" as const,
  },
});

const doc = (
  file: string,
  app: string,
  extra: Partial<LoadedDocument["document"]> = {}
): LoadedDocument => ({
  file,
  document: { version: "1.0.0", app, ...extra },
});

describe("validateSet", () => {
  it("accepts a clean set", () => {
    const problems = validateSet([
      doc("a.json", "a", {
        spaceKinds: [kind("a:one")],
        messageTypes: [{ name: "a:card", payloadSchema: { type: "object" } }],
      }),
      doc("b.json", "b", { spaceKinds: [kind("b:one")] }),
    ]);

    expect(problems).toEqual([]);
  });

  it("refuses the same app in two documents", () => {
    const problems = validateSet([doc("a.json", "x"), doc("b.json", "x")]);

    const text = JSON.stringify(problems);
    expect(problems).toHaveLength(1);
    expect(text).toContain("a.json");
    expect(text).toContain("b.json");
  });

  it("refuses the same kind name twice", () => {
    const problems = validateSet([
      doc("a.json", "a", { spaceKinds: [kind("a:one"), kind("a:one")] }),
    ]);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({
      file: "a.json",
      path: "spaceKinds[1].name",
    });
  });

  it("refuses a kind named default", () => {
    const problems = validateSet([
      doc("a.json", "a", { spaceKinds: [kind("default")] }),
    ]);

    expect(problems).toHaveLength(1);
    expect(problems[0].message).toMatch(/built-in/);
  });

  it("refuses a message type named text", () => {
    const problems = validateSet([
      doc("a.json", "a", {
        messageTypes: [{ name: "text", payloadSchema: {} }],
      }),
    ]);

    expect(problems).toHaveLength(1);
    expect(problems[0].message).toMatch(/built-in/);
  });

  it("refuses a payloadSchema Ajv cannot compile", () => {
    const problems = validateSet([
      doc("a.json", "a", {
        messageTypes: [{ name: "a:bad", payloadSchema: { type: "nonsense" } }],
      }),
    ]);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({
      file: "a.json",
      path: "messageTypes[0].payloadSchema",
    });
  });

  it("returns every problem, not the first", () => {
    const problems = validateSet([
      doc("a.json", "a", { spaceKinds: [kind("default")] }),
      doc("b.json", "b", {
        messageTypes: [{ name: "text", payloadSchema: {} }],
      }),
      doc("c.json", "c", {
        messageTypes: [{ name: "c:bad", payloadSchema: { type: "nonsense" } }],
      }),
    ]);

    expect(problems.map((p) => p.file)).toEqual(["a.json", "b.json", "c.json"]);
  });
});
