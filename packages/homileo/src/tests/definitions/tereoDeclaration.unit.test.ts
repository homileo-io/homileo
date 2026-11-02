// @module-tag unit
// @module-tag provisioning
import { privateWebhookEventTypes, webhookEventTypes } from "@homileo-io/sdk";
import { buildTereoDocument } from "../../definitions/tereoDeclaration.js";
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

  it("declares homileo.chat.admin, homileo.spaces.write, homileo.spaces.read and homileo.messages.read_private", () => {
    const permissions = service.permissions!;
    const names = permissions.map((p) => p.name);

    expect(names).toEqual(
      expect.arrayContaining([
        "homileo.chat.admin",
        "homileo.spaces.write",
        "homileo.spaces.read",
        "homileo.messages.read_private",
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

  it("declares exactly the webhook event types, private ones readable only with homileo.messages.read_private", () => {
    const events = service.eventTypes!;
    const privateTypes = new Set(privateWebhookEventTypes());

    expect(events.map((e) => e.eventType).sort()).toEqual(
      webhookEventTypes().sort()
    );
    expect(privateTypes.has("homileo.private_message.created")).toBe(true);
    for (const e of events) {
      expect(e.readPermission, e.eventType).toBe(
        privateTypes.has(e.eventType)
          ? "homileo.messages.read_private"
          : "homileo.spaces.read"
      );
    }
  });

  it("asks for the audit_writer, webhook_publisher and notification_sender roles", () => {
    expect(service.access?.roles?.sort()).toEqual([
      "audit_writer",
      "notification_sender",
      "webhook_publisher",
    ]);
  });

  it("matches the committed tereo-provisioning.json", () => {
    const read = (file: string) =>
      JSON.parse(readFileSync(new URL(file, import.meta.url), "utf-8"));
    const { version } = read("../../../package.json");

    // Built from the package's own version, so a release bump without
    // `npm run tereo:provisioning` fails here.
    expect(read("../../../tereo-provisioning.json")).toEqual(
      buildTereoDocument(version)
    );
  });
});
