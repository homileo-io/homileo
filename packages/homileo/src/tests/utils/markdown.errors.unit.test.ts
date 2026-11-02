// @module-tag unit
// @module-tag messages
import { parseBody } from "../../utils/markdown.js";
import { describe, expect, it, vi } from "vitest";

vi.mock("mdast-util-from-markdown", async (original) => {
  const actual = await original<typeof import("mdast-util-from-markdown")>();
  return {
    ...actual,
    fromMarkdown: (value: string, ...rest: unknown[]) => {
      if (value === "overflow")
        throw new RangeError("Maximum call stack size exceeded");
      if (value === "broken") throw new TypeError("broken");
      return (actual.fromMarkdown as (...a: unknown[]) => unknown)(
        value,
        ...rest
      );
    },
  };
});

describe("parseBody when micromark fails", () => {
  it("reads a body that overflows the stack as plain text", () => {
    expect(parseBody("overflow")).toBeNull();
  });

  it("rethrows any other error", () => {
    expect(() => parseBody("broken")).toThrow(TypeError);
  });

  it("still parses other bodies", () => {
    expect(parseBody("*a*")?.type).toBe("root");
  });
});
