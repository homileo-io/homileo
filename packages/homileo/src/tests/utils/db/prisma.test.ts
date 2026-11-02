// @module-tag int
// @module-tag platform
import { endPool, poolConfig } from "../../../utils/db/prisma.js";
import { describe, expect, it } from "vitest";
import { Pool } from "pg";

describe("endPool", () => {
  it("returns false, without waiting on it, while a client stays checked out", async () => {
    const pool = new Pool({ ...poolConfig, max: 1, min: 0 });
    const client = await pool.connect();

    try {
      expect(await endPool(pool, 50)).toBe(false);
    } finally {
      client.release();
    }
  });

  it("returns true once the pool has ended", async () => {
    const pool = new Pool({ ...poolConfig, max: 1, min: 0 });
    (await pool.connect()).release();

    expect(await endPool(pool, 10_000)).toBe(true);
    expect(pool.ended).toBe(true);
  });
});
