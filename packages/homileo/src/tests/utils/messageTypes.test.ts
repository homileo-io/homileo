// @module-tag int
// @module-tag provisioning
// @module-tag messages
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { validatePayload } from "../../utils/messageTypes.js";
import { provision } from "../../utils/provisioning/index.js";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { prisma } from "../../utils/db/prisma.js";
import { tmpdir } from "os";
import { join } from "path";

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
    await validatePayload(TYPE, payload);
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

  it("refuses a payload on the built-in text type", async () => {
    await expect(validatePayload("text", undefined)).resolves.toBeUndefined();
    await expect(validatePayload("text", { a: 1 })).rejects.toMatchObject({
      code: "invalid_payload",
    });
  });
});
