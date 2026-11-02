// @module-tag int
// @module-tag provisioning
// @module-tag messages
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { provision } from "../../utils/provisioning/index.js";
import { MAX_ISSUE_CHARS } from "../../utils/validateReq.js";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { prisma } from "../../utils/db/prisma.js";
import { tmpdir } from "os";
import { join } from "path";
import {
  MAX_PAYLOAD_ISSUES,
  validatePayload,
} from "../../utils/messageTypes.js";

const TYPE = "types-test:card";
let dir: string;

const provisionWith = async (payloadSchema: object | null) => {
  await writeFile(
    join(dir, "types-test.json"),
    JSON.stringify({
      version: "1.0.0",
      app: "types-test",
      messageTypes: payloadSchema ? [{ name: TYPE, payloadSchema }] : [],
    })
  );
  await provision({ path: dir });
};

const wipe = async () => {
  await prisma.provisionedSpaceKind.deleteMany();
  await prisma.provisionedMessageType.deleteMany();
};

const codeOf = async (payload: unknown) => {
  try {
    await prisma.$transaction((tx) => validatePayload(TYPE, payload, tx));
    return null;
  } catch (err) {
    return (err as { code?: string }).code;
  }
};

describe("validatePayload", () => {
  beforeEach(async () => {
    await wipe();
    dir = await mkdtemp(join(tmpdir(), "homileo-types-"));
  });
  afterAll(async () => {
    await wipe();
    await rm(dir, { recursive: true, force: true });
  });

  it("validates against the schema re-provisioning applied, not the cached one", async () => {
    await provisionWith({ type: "object" });
    expect(await codeOf({ amount: "three" })).toBeNull();

    await provisionWith({
      type: "object",
      properties: { amount: { type: "number" } },
    });

    expect(await codeOf({ amount: "three" })).toBe("invalid_payload");
    expect(await codeOf({ amount: 3 })).toBeNull();
  });

  it("refuses a type once re-provisioning retires it", async () => {
    await provisionWith({ type: "object" });
    expect(await codeOf({})).toBeNull();

    await provisionWith(null);

    expect(await codeOf({})).toBe("message_type_not_found");
  });

  it("refuses a type another replica retired, though this one validated it", async () => {
    await provisionWith({ type: "object" });
    expect(await codeOf({})).toBeNull();

    await prisma.provisionedMessageType.update({
      where: { name: TYPE },
      data: { retiredAt: new Date() },
    });

    expect(await codeOf({})).toBe("message_type_not_found");
  });

  it("validates against a schema another replica changed", async () => {
    await provisionWith({ type: "object" });
    expect(await codeOf({ amount: "three" })).toBeNull();

    await prisma.provisionedMessageType.update({
      where: { name: TYPE },
      data: {
        payloadSchema: {
          type: "object",
          properties: { amount: { type: "number" } },
        },
      },
    });

    expect(await codeOf({ amount: "three" })).toBe("invalid_payload");
  });

  it.each([
    [
      "an array of many bad items",
      { type: "array", items: { type: "number" } },
      Array.from({ length: 500 }, () => "x"),
    ],
    [
      "an anyOf with many failing branches",
      {
        anyOf: Array.from({ length: 40 }, (_, i) => ({ const: i })),
      },
      "none",
    ],
  ])(
    "caps the issues it returns for %s",
    async (_name, payloadSchema, payload) => {
      await provisionWith(payloadSchema);

      const failure = await prisma
        .$transaction((tx) => validatePayload(TYPE, payload, tx))
        .catch((err: unknown) => err as { details: { issues: unknown[] } });

      expect(failure).toMatchObject({ code: "invalid_payload" });
      const { issues } = (failure as { details: { issues: unknown[] } })
        .details;
      expect(issues.length).toBeGreaterThan(0);
      expect(issues.length).toBeLessThanOrEqual(MAX_PAYLOAD_ISSUES);
    }
  );

  it("truncates each issue's path, which holds the payload's own keys", async () => {
    await provisionWith({
      type: "object",
      additionalProperties: { type: "number" },
    });
    const payload = Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [`${i}${"k".repeat(60_000)}`, "x"])
    );

    const failure = await prisma
      .$transaction((tx) => validatePayload(TYPE, payload, tx))
      .catch((err: unknown) => err as { details: { issues: unknown[] } });

    expect(failure).toMatchObject({ code: "invalid_payload" });
    const { issues } = (failure as { details: { issues: unknown[] } }).details;
    expect(issues.length).toBeLessThanOrEqual(MAX_PAYLOAD_ISSUES);
    expect(JSON.stringify(issues).length).toBeLessThan(
      MAX_PAYLOAD_ISSUES * 2 * (MAX_ISSUE_CHARS + 50)
    );
  });

  it("refuses a payload on the built-in text type", async () => {
    await expect(
      validatePayload("text", undefined, prisma)
    ).resolves.toBeUndefined();
    await expect(
      validatePayload("text", { a: 1 }, prisma)
    ).rejects.toMatchObject({
      code: "invalid_payload",
    });
  });
});
