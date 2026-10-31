// @module-tag int
// @module-tag provisioning
import { BUILTIN_KIND } from "../../definitions/builtins.js";
import { afterAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../../utils/db/prisma.js";
import { v7 as uuidv7 } from "uuid";
import {
  activeKind,
  getKind,
  invalidateKinds,
  kindsGrantingRead,
} from "../../utils/kinds.js";

const names: string[] = [];

const newName = (prefix: string) => {
  const name = `${prefix}:${uuidv7().slice(-12)}`;
  names.push(name);
  return name;
};

const definition = (
  name: string,
  grants: Array<{ permission: string; access: "read" | "moderate" }> = []
) => ({
  name,
  defaults: { visibility: "members", join: "invite", posting: "members" },
  overridable: [],
  states: [],
  grants,
  bots: [],
  editWindowSeconds: null,
  search: { metadata: [] },
});

const insertKind = (
  name: string,
  o: { grants?: Parameters<typeof definition>[1]; retired?: boolean } = {}
) =>
  prisma.provisionedSpaceKind.create({
    data: {
      name,
      app: "kinds-test",
      definition: definition(name, o.grants),
      documentVersion: "1.0.0",
      sourceFile: "kinds.json",
      retiredAt: o.retired ? new Date() : null,
    },
  });

describe("kinds", () => {
  afterAll(async () => {
    await prisma.provisionedSpaceKind.deleteMany({
      where: { name: { in: names } },
    });
    invalidateKinds();
  });

  it("getKind returns the built-in kind", async () => {
    expect(await getKind("default")).toEqual(BUILTIN_KIND);
  });

  it("getKind returns null for an unknown kind", async () => {
    expect(await getKind(newName("kinds-test"))).toBeNull();
  });

  it("getKind returns a retired kind", async () => {
    const name = newName("kinds-test");
    await insertKind(name, { retired: true });
    invalidateKinds();

    expect((await getKind(name))?.name).toBe(name);
  });

  it("invalidateKinds picks up a re-provisioned definition", async () => {
    const name = newName("kinds-test");
    await insertKind(name);
    invalidateKinds();
    expect((await getKind(name))?.editWindowSeconds).toBeNull();

    await prisma.provisionedSpaceKind.update({
      where: { name },
      data: { definition: { ...definition(name), editWindowSeconds: 300 } },
    });
    expect((await getKind(name))?.editWindowSeconds).toBeNull();
    invalidateKinds();

    expect((await getKind(name))?.editWindowSeconds).toBe(300);
  });

  it("expires the cache after 60 seconds", async () => {
    const name = newName("kinds-test");
    await insertKind(name);
    invalidateKinds();
    await getKind(name);
    await prisma.provisionedSpaceKind.update({
      where: { name },
      data: { definition: { ...definition(name), editWindowSeconds: 120 } },
    });
    const now = Date.now();
    const spy = vi.spyOn(Date, "now").mockReturnValue(now + 61_000);

    try {
      expect((await getKind(name))?.editWindowSeconds).toBe(120);
    } finally {
      spy.mockRestore();
    }
  });

  it("kindsGrantingRead lists kinds whose grant permission the caller holds, hierarchy included", async () => {
    const support = newName("support");
    const other = newName("billing");
    await insertKind(support, {
      grants: [{ permission: "support.cases.read", access: "read" }],
    });
    await insertKind(other, {
      grants: [{ permission: "billing.invoices.read", access: "read" }],
    });
    invalidateKinds();

    const granted = await kindsGrantingRead(["support.cases.admin"]);

    expect(granted).toContain(support);
    expect(granted).not.toContain(other);
    expect(await kindsGrantingRead([])).not.toContain(support);
  });

  it("kindsGrantingRead includes a retired kind", async () => {
    const name = newName("retired");
    await insertKind(name, {
      retired: true,
      grants: [{ permission: "retired.things.read", access: "read" }],
    });
    invalidateKinds();

    expect(await kindsGrantingRead(["retired.things.read"])).toContain(name);
  });

  describe("activeKind", () => {
    it("returns the built-in kind without a query", async () => {
      const result = await prisma.$transaction((tx) =>
        activeKind(tx, "default")
      );

      expect(result).toEqual(BUILTIN_KIND);
    });

    it("returns an active kind and null for a retired or unknown one", async () => {
      const active = newName("kinds-test");
      const retired = newName("kinds-test");
      await insertKind(active);
      await insertKind(retired, { retired: true });

      const [a, r, u] = await prisma.$transaction(async (tx) => [
        await activeKind(tx, active),
        await activeKind(tx, retired),
        await activeKind(tx, newName("kinds-test")),
      ]);

      expect(a?.name).toBe(active);
      expect(r).toBeNull();
      expect(u).toBeNull();
    });

    it("holds the kind row against a concurrent retire until the transaction ends", async () => {
      const name = newName("kinds-test");
      await insertKind(name);
      let retireFinished = false;
      let retire: Promise<void> = Promise.resolve();

      await prisma.$transaction(async (tx) => {
        await activeKind(tx, name);
        retire = prisma
          .$transaction(async (tx2) => {
            await tx2.$queryRaw`SELECT name FROM "chat"."provisioned_space_kinds" WHERE name = ${name} FOR UPDATE`;
          })
          .then(() => {
            retireFinished = true;
          });
        await new Promise((r) => setTimeout(r, 300));
        expect(retireFinished).toBe(false);
      });
      await retire;

      expect(retireFinished).toBe(true);
    });
  });
});
