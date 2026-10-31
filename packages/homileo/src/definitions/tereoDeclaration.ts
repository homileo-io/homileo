import type { ProvisioningDocument } from "@tereo-io/sdk";
import { webhookEventTypes } from "@homileo-io/sdk";

/** The tereo bucket that holds message attachments. */
export const ATTACHMENTS_BUCKET = "homileo-attachments";

/**
 * What Homileo declares to tereo as an app service. Core applies the
 * generated `tereo-provisioning.json` from its provisioning folder.
 */
export const buildTereoDocument = (version: string): ProvisioningDocument => ({
  version,
  service: {
    slug: "homileo",
    name: "Homileo",
    secretFrom: "TEREO_CLIENT_SECRET",
    // Audit entries, webhook events and notifications leave through the
    // outbox in the SDK, under these core roles.
    access: {
      roles: ["audit_writer", "webhook_publisher", "notification_sender"],
    },
    permissions: [
      {
        name: "homileo.spaces.read",
        displayName: "Read spaces",
        description: "Read spaces, sessions and messages, and their events",
        orgAssignable: true,
      },
      {
        name: "homileo.spaces.write",
        displayName: "Use spaces",
        description: "Create spaces and sessions, and post messages",
        orgAssignable: true,
      },
      {
        name: "homileo.chat.admin",
        displayName: "Administer chat",
        description: "Administer every space and session of the organization",
        orgAssignable: true,
      },
    ],
    systemRoles: [
      {
        name: "homileo_user",
        displayName: "Homileo user",
        description: "Takes part in chat",
        permissions: ["homileo.spaces.write"],
      },
    ],
    buckets: [
      {
        bucketName: ATTACHMENTS_BUCKET,
        description: "Message attachments",
        policy: "private",
      },
    ],
    eventTypes: webhookEventTypes().map((eventType) => ({
      eventType,
      description: eventType,
      readPermission: "homileo.spaces.read",
    })),
  },
});
