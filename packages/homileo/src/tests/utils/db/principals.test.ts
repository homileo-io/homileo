// @module-tag int
// @module-tag auth
import { prisma } from "../../../utils/db/prisma.js";
import { db } from "../../../utils/db/index.js";
import { describe, expect, it } from "vitest";
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
});
