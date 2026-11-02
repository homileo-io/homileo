// @module-tag unit
// @module-tag platform
import { afterEach, describe, expect, it, vi } from "vitest";

describe("preload", () => {
  const original = process.env.LOG_LEVEL;

  afterEach(() => {
    process.env.LOG_LEVEL = original;
  });

  it("defaults an empty LOG_LEVEL to info", async () => {
    process.env.LOG_LEVEL = "";
    vi.resetModules();

    await import("../preload.js");

    expect(process.env.LOG_LEVEL).toBe("info");
  });
});
