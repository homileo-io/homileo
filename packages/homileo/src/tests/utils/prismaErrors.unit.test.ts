// @module-tag unit
// @module-tag platform
import { isUniqueViolationOn } from "../../utils/prismaErrors.js";
import { describe, expect, it } from "vitest";

const adapterError = (table: string, index: string) => ({
  code: "P2002",
  meta: {
    driverAdapterError: {
      cause: {
        kind: "UniqueConstraintViolation",
        originalCode: "23505",
        table,
        constraint: { index },
      },
    },
  },
});

describe("isUniqueViolationOn", () => {
  it("accepts the table's own primary key", () => {
    expect(
      isUniqueViolationOn(
        adapterError("space_members", "space_members_pkey"),
        "space_members",
        ["space_id", "user_id"]
      )
    ).toBe(true);
  });

  it("refuses a primary key violation of another table", () => {
    for (const [table, index] of [
      ["events", "events_pkey"],
      ["core_outbox", "core_outbox_pkey"],
      ["space_join_requests", "space_join_requests_pkey"],
    ])
      expect(
        isUniqueViolationOn(adapterError(table, index), "space_members", [
          "space_id",
          "user_id",
        ])
      ).toBe(false);
  });

  it("matches a P2002 that carries only meta.target by its columns", () => {
    const columns = ["space_id", "user_id"];
    expect(
      isUniqueViolationOn(
        { code: "P2002", meta: { target: ["space_id", "user_id"] } },
        "space_members",
        columns
      )
    ).toBe(true);
    expect(
      isUniqueViolationOn(
        { code: "P2002", meta: { target: ["id"] } },
        "space_members",
        columns
      )
    ).toBe(false);
  });

  it("refuses an error that is not a unique violation", () => {
    expect(isUniqueViolationOn(new Error("x"), "space_members", [])).toBe(
      false
    );
  });
});
