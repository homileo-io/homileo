// @module-tag int
// @module-tag auth
import { setProfileLookup } from "../../../utils/db/principals.js";
import { afterEach, describe, expect, it } from "vitest";
import { prisma } from "../../../utils/db/prisma.js";
import { db } from "../../../utils/db/index.js";
import { v7 as uuidv7 } from "uuid";

describe("db.principals.findOrCreateUser", () => {
  it("seeds the display name from the token on creation", async () => {
    const tereoUserId = uuidv7();

    const principal = await db.principals.findOrCreateUser({
      tereoUserId,
      isBot: false,
      displayName: "Ada Lovelace",
    });

    expect(principal.displayName).toBe("Ada Lovelace");
    expect(principal.profileRefreshedAt).toBeNull();
  });

  it("returns the existing principal without changing it", async () => {
    const tereoUserId = uuidv7();
    const created = await prisma.principal.create({
      data: { kind: "user", tereoUserId, displayName: "Kept" },
    });

    const found = await db.principals.findOrCreateUser({
      tereoUserId,
      isBot: false,
      displayName: "Other",
    });

    expect(found).toEqual(created);
  });

  it.each([true, false])(
    "re-derives is_bot from the token when the stored row says %s",
    async (stored) => {
      const tereoUserId = uuidv7();
      await prisma.principal.create({
        data: { kind: "user", tereoUserId, isBot: stored },
      });

      const found = await db.principals.findOrCreateUser({
        tereoUserId,
        isBot: !stored,
        displayName: null,
      });

      expect(found.isBot).toBe(!stored);
      expect(
        (await prisma.principal.findUniqueOrThrow({ where: { tereoUserId } }))
          .isBot
      ).toBe(!stored);
    }
  );
});

describe("db.principals.findOrCreateMany", () => {
  it("returns the principal of an upper-case id", async () => {
    const tereoUserId = uuidv7();

    const [bot] = await db.principals.ensureBotPrincipals([
      tereoUserId.toUpperCase(),
    ]);

    expect(bot.tereoUserId).toBe(tereoUserId);
    expect(bot.isBot).toBe(true);
  });
});

describe("avatar URL length", () => {
  afterEach(() => setProfileLookup(null));

  it("stores null for an avatar URL over 2048 characters and still refreshes the name", async () => {
    const principal = await prisma.principal.create({
      data: {
        kind: "user",
        tereoUserId: uuidv7(),
        displayName: "Old",
        avatarUrl: "https://example.test/old.png",
      },
    });
    const photo = `https://example.test/${"a".repeat(2100)}.png`;
    setProfileLookup(async (id) => ({ id, name: "New", photo }) as never);

    await db.principals.refreshProfile(principal);

    const after = await prisma.principal.findUniqueOrThrow({
      where: { id: principal.id },
    });
    expect(after.displayName).toBe("New");
    expect(after.avatarUrl).toBeNull();
  });
});

describe("display name length", () => {
  afterEach(() => setProfileLookup(null));

  it("truncates a display name longer than 255 characters", async () => {
    const long = "a".repeat(300);

    const created = await db.principals.findOrCreateUser({
      tereoUserId: uuidv7(),
      isBot: false,
      displayName: long,
    });
    expect(created.displayName).toBe("a".repeat(255));

    const refreshed = await prisma.principal.create({
      data: { kind: "user", tereoUserId: uuidv7(), displayName: "Old" },
    });
    setProfileLookup(async (id) => ({ id, name: long }) as never);
    await db.principals.refreshProfile(refreshed);
    const after = await prisma.principal.findUniqueOrThrow({
      where: { id: refreshed.id },
    });
    expect(after.displayName).toBe("a".repeat(255));
  });

  it("never splits a surrogate pair at the cut", async () => {
    const created = await db.principals.findOrCreateUser({
      tereoUserId: uuidv7(),
      isBot: false,
      displayName: "😀".repeat(300),
    });

    expect(Array.from(created.displayName!)).toHaveLength(255);
  });
});
