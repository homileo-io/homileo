// @module-tag unit
// @module-tag provisioning
import { buildTereoDocument } from "../../definitions/tereoDeclaration.js";
import { webhookEventTypes } from "@homileo-io/sdk";
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";

const document = buildTereoDocument("1.2.3");
const service = document.service!;

describe("buildTereoDocument", () => {
  it("declares the service homileo with secretFrom TEREO_CLIENT_SECRET", () => {
    expect(document.version).toBe("1.2.3");
    expect(service.slug).toBe("homileo");
    expect(service.secretFrom).toBe("TEREO_CLIENT_SECRET");
  });

  it("declares homileo.chat.admin and homileo.spaces.write", () => {
    const permissions = service.permissions!;
    const names = permissions.map((p) => p.name);

    expect(names).toEqual(
      expect.arrayContaining([
        "homileo.chat.admin",
        "homileo.spaces.write",
        "homileo.spaces.read",
      ])
    );
    expect(permissions.every((p) => p.orgAssignable === true)).toBe(true);
    expect(service.systemRoles).toEqual([
      expect.objectContaining({
        name: "homileo_user",
        permissions: ["homileo.spaces.write"],
      }),
    ]);
  });

  it("declares the bucket homileo-attachments, private", () => {
    expect(service.buckets).toEqual([
      expect.objectContaining({
        bucketName: "homileo-attachments",
        policy: "private",
      }),
    ]);
  });

  it("declares exactly the webhook event types, each readable with homileo.spaces.read", () => {
    const events = service.eventTypes!;

    expect(events.map((e) => e.eventType).sort()).toEqual(
      webhookEventTypes().sort()
    );
    expect(
      events.every((e) => e.readPermission === "homileo.spaces.read")
    ).toBe(true);
  });

  it("asks for the audit_writer, webhook_publisher and notification_sender roles", () => {
    expect(service.access?.roles?.sort()).toEqual([
      "audit_writer",
      "notification_sender",
      "webhook_publisher",
    ]);
  });

  it("matches the committed tereo-provisioning.json", () => {
    const committed = JSON.parse(
      readFileSync(
        new URL("../../../tereo-provisioning.json", import.meta.url),
        "utf-8"
      )
    );
    const { version } = committed;

    expect(committed).toEqual(buildTereoDocument(version));
  });
});
