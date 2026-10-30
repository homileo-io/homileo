// @module-tag int
// @module-tag provisioning
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { BUILTIN_KIND } from "../../../definitions/builtins.js";
import { chatFixtures } from "../../support/chatFixtures.js";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { prisma } from "../../../utils/db/prisma.js";
import { tmpdir } from "os";
import { join } from "path";
import {
  ProvisioningError,
  loadKinds,
  provision,
} from "../../../utils/provisioning/index.js";

const fixtures = chatFixtures();
const dirs: string[] = [];

const kind = (name: string, extra: object = {}) => ({
  name,
  defaults: { visibility: "members", join: "invite", posting: "members" },
  ...extra,
});

/** A directory holding one document per entry. */
const provisioningDir = async (docs: Record<string, unknown>) => {
  const dir = await mkdtemp(join(tmpdir(), "homileo-prov-"));
  dirs.push(dir);
  for (const [file, doc] of Object.entries(docs))
    await writeFile(
      join(dir, file),
      typeof doc === "string" ? doc : JSON.stringify(doc)
    );
  return dir;
};

const supportDoc = (extra: object = {}) => ({
  version: "1.0.0",
  app: "support",
  spaceKinds: [kind("support:case", { states: ["open", "resolved"] })],
  messageTypes: [{ name: "support:card", payloadSchema: { type: "object" } }],
  ...extra,
});

const wipe = async () => {
  await prisma.provisionedSpaceKind.deleteMany();
  await prisma.provisionedMessageType.deleteMany();
};

describe("provision", () => {
  beforeEach(async () => {
    await fixtures.cleanup();
    await wipe();
  });
  afterAll(async () => {
    await fixtures.cleanup();
    await wipe();
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  });

  it("applies kinds and message types in one transaction", async () => {
    const path = await provisioningDir({ "support.json": supportDoc() });

    const result = await provision({ path });

    expect(result).toEqual({ applied: 2, retired: [] });
    const kinds = await loadKinds();
    expect(kinds.get("support:case")).toMatchObject({
      states: ["open", "resolved"],
      overridable: [],
      editWindowSeconds: null,
    });
    expect(kinds.get("default")).toEqual(BUILTIN_KIND);
    expect(
      await prisma.provisionedMessageType.findUnique({
        where: { name: "support:card" },
      })
    ).toMatchObject({
      app: "support",
      sourceFile: "support.json",
      retiredAt: null,
    });
  });

  it("is idempotent", async () => {
    const path = await provisioningDir({ "support.json": supportDoc() });
    await provision({ path });
    const before = await prisma.provisionedSpaceKind.findUniqueOrThrow({
      where: { name: "support:case" },
    });

    const result = await provision({ path });

    expect(result).toEqual({ applied: 0, retired: [] });
    const after = await prisma.provisionedSpaceKind.findUniqueOrThrow({
      where: { name: "support:case" },
    });
    expect(after.updatedAt).toEqual(before.updatedAt);
  });

  it("updates a kind whose declaration changed", async () => {
    await provision({
      path: await provisioningDir({ "support.json": supportDoc() }),
    });

    const result = await provision({
      path: await provisioningDir({
        "support.json": supportDoc({
          spaceKinds: [kind("support:case", { editWindowSeconds: 60 })],
        }),
      }),
    });

    expect(result.applied).toBe(1);
    expect((await loadKinds()).get("support:case")?.editWindowSeconds).toBe(60);
  });

  it("retires a kind removed from the documents", async () => {
    await provision({
      path: await provisioningDir({ "support.json": supportDoc() }),
    });

    const result = await provision({
      path: await provisioningDir({
        "support.json": supportDoc({ spaceKinds: [] }),
      }),
    });

    expect(result.retired).toEqual(["support:case"]);
    const row = await prisma.provisionedSpaceKind.findUniqueOrThrow({
      where: { name: "support:case" },
    });
    expect(row.retiredAt).not.toBeNull();
    expect((await loadKinds()).has("support:case")).toBe(false);
  });

  it("re-activates a retired kind that returns", async () => {
    const without = await provisioningDir({
      "support.json": supportDoc({ spaceKinds: [] }),
    });
    const withKind = await provisioningDir({ "support.json": supportDoc() });
    await provision({ path: withKind });
    await provision({ path: without });

    await provision({ path: withKind });

    expect((await loadKinds()).has("support:case")).toBe(true);
  });

  it("refuses to retire a kind with unarchived spaces", async () => {
    const withKind = await provisioningDir({ "support.json": supportDoc() });
    await provision({ path: withKind });
    await fixtures.space("support:case");
    await fixtures.space("support:case", true);

    const error = await provision({
      path: await provisioningDir({
        "support.json": supportDoc({
          spaceKinds: [],
          messageTypes: [
            { name: "support:other", payloadSchema: { type: "object" } },
          ],
        }),
      }),
    }).catch((e) => e);

    expect(error).toBeInstanceOf(ProvisioningError);
    expect(error.problems[0].message).toMatch(/unarchived space/);
    expect((await loadKinds()).has("support:case")).toBe(true);
    expect(
      await prisma.provisionedMessageType.findUnique({
        where: { name: "support:other" },
      })
    ).toBeNull();
  });

  it("retires a kind whose spaces are all archived", async () => {
    await provision({
      path: await provisioningDir({ "support.json": supportDoc() }),
    });
    await fixtures.space("support:case", true);

    const result = await provision({
      path: await provisioningDir({
        "support.json": supportDoc({ spaceKinds: [] }),
      }),
    });

    expect(result.retired).toEqual(["support:case"]);
  });

  it("refuses to retire a message type existing messages use", async () => {
    await provision({
      path: await provisioningDir({ "support.json": supportDoc() }),
    });
    await fixtures.message("support:card");

    const error = await provision({
      path: await provisioningDir({
        "support.json": supportDoc({ messageTypes: [] }),
      }),
    }).catch((e) => e);

    expect(error).toBeInstanceOf(ProvisioningError);
    expect(error.problems[0].message).toMatch(/messages use it/);
    expect(
      (
        await prisma.provisionedMessageType.findUniqueOrThrow({
          where: { name: "support:card" },
        })
      ).retiredAt
    ).toBeNull();
  });

  it("applies nothing when any document is invalid", async () => {
    const path = await provisioningDir({
      "a.json": supportDoc(),
      "b.json": { version: "nope", app: "other" },
    });

    const error = await provision({ path }).catch((e) => e);

    expect(error).toBeInstanceOf(ProvisioningError);
    expect(await prisma.provisionedSpaceKind.count()).toBe(0);
    expect(await prisma.provisionedMessageType.count()).toBe(0);
  });

  it("applies nothing when the set breaks a cross-document rule", async () => {
    const path = await provisioningDir({
      "a.json": supportDoc(),
      "b.json": supportDoc(),
    });

    const error = await provision({ path }).catch((e) => e);

    expect(error).toBeInstanceOf(ProvisioningError);
    expect(await prisma.provisionedSpaceKind.count()).toBe(0);
  });

  it("reads only the json files directly inside the directory", async () => {
    const path = await provisioningDir({
      "support.json": supportDoc(),
      ".hidden.json": "not json",
      "notes.txt": "not json",
    });

    const result = await provision({ path });

    expect(result.applied).toBe(2);
  });

  it("refuses a directory with no documents", async () => {
    const path = await provisioningDir({ "notes.txt": "x" });

    await expect(provision({ path })).rejects.toBeInstanceOf(ProvisioningError);
  });

  it("leaves everything as it is when PROVISIONING_PATH is unset", async () => {
    await provision({
      path: await provisioningDir({ "support.json": supportDoc() }),
    });

    const result = await provision();

    expect(result).toEqual({ applied: 0, retired: [] });
    expect((await loadKinds()).has("support:case")).toBe(true);
  });
});
