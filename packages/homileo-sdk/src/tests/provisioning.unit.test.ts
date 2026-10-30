import { provisioningDocumentSchema } from "../provisioning/schema.js";
import { describe, expect, it } from "vitest";

const BOT = "0192f3a0-7b1c-7d2e-8f3a-123456789abc";

const valid = {
  version: "1.0.0",
  app: "support",
  spaceKinds: [
    {
      name: "support:case",
      defaults: { visibility: "members", join: "invite", posting: "members" },
      overridable: [],
      states: ["open", "resolved"],
      grants: [{ permission: "support.cases.read", access: "moderate" }],
      bots: [BOT],
      editWindowSeconds: null,
      search: { metadata: ["customerName", "orderNumber"] },
    },
  ],
  messageTypes: [
    {
      name: "support:order-card",
      payloadSchema: { type: "object", properties: { id: { type: "string" } } },
    },
  ],
};

const kind = (patch: Record<string, unknown>) => ({
  ...valid,
  spaceKinds: [{ ...valid.spaceKinds[0], ...patch }],
});

const INVALID: [string, unknown, string][] = [
  ["an unknown top-level key", { ...valid, extra: 1 }, ""],
  ["a missing version", { ...valid, version: undefined }, "version"],
  ["a bad semver", { ...valid, version: "1.0" }, "version"],
  ["an uppercase app", { ...valid, app: "Support" }, "app"],
  [
    "a kind name without the app prefix",
    kind({ name: "case" }),
    "spaceKinds.0.name",
  ],
  [
    "an overridable of an unknown field",
    kind({ overridable: ["color"] }),
    "spaceKinds.0.overridable.0",
  ],
  [
    "duplicate states",
    kind({ states: ["open", "open"] }),
    "spaceKinds.0.states",
  ],
  [
    "a grant of access write",
    kind({ grants: [{ permission: "a.b", access: "write" }] }),
    "spaceKinds.0.grants.0.access",
  ],
  ["a non-UUID bot", kind({ bots: ["nope"] }), "spaceKinds.0.bots.0"],
  [
    "a negative editWindowSeconds",
    kind({ editWindowSeconds: -1 }),
    "spaceKinds.0.editWindowSeconds",
  ],
  [
    "a message type name without the prefix",
    { ...valid, messageTypes: [{ name: "order-card", payloadSchema: {} }] },
    "messageTypes.0.name",
  ],
];

describe("provisioningDocumentSchema", () => {
  it("parses the spec's example", () => {
    expect(provisioningDocumentSchema.safeParse(valid).success).toBe(true);
  });

  it.each(INVALID)("refuses %s", (_label, doc, path) => {
    const result = provisioningDocumentSchema.safeParse(doc);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((i) => i.path.join("."))).toContain(path);
  });
});
