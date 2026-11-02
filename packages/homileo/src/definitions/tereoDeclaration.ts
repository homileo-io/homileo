import { privateWebhookEventTypes, webhookEventTypes } from "@homileo-io/sdk";
import type { ProvisioningDocument } from "@tereo-io/sdk";

/**
 * Homileo's service slug in tereo. Its permissions and event types are named
 * under it, and tereo refuses an audit entry from any other source.
 */
export const SERVICE_SLUG = "homileo";

/** The tereo bucket that holds message attachments. */
export const ATTACHMENTS_BUCKET = "homileo-attachments";

/** Needed by every `/v1` route and every socket (`canReadChat`). */
export const SPACES_READ_PERMISSION = "homileo.spaces.read";

/** Needed by every route that changes shared chat state (`canWriteChat`). */
export const SPACES_WRITE_PERMISSION = "homileo.spaces.write";

export const CHAT_ADMIN_PERMISSION = "homileo.chat.admin";

/** Receives the webhook events of private sessions (`isPrivateSession`). */
export const READ_PRIVATE_PERMISSION = "homileo.messages.read_private";

const privateTypes = new Set(privateWebhookEventTypes());

/**
 * What Homileo declares to tereo as an app service. Core applies the
 * generated `tereo-provisioning.json` from its provisioning folder.
 */
export const buildTereoDocument = (version: string): ProvisioningDocument => ({
  version,
  service: {
    slug: SERVICE_SLUG,
    name: "Homileo",
    secretFrom: "TEREO_CLIENT_SECRET",
    // Audit entries, webhook events and notifications leave through the
    // outbox in the SDK, under these core roles.
    access: {
      roles: ["audit_writer", "webhook_publisher", "notification_sender"],
    },
    permissions: [
      {
        name: SPACES_READ_PERMISSION,
        displayName: "Read spaces",
        description:
          "Use the chat API and realtime: read spaces, sessions and messages, keep one's own read state, and receive their webhook events",
        orgAssignable: true,
      },
      {
        name: SPACES_WRITE_PERMISSION,
        displayName: "Use spaces",
        description:
          "Create and change spaces, sessions and their members; post, edit and react to messages",
        orgAssignable: true,
      },
      {
        // Off the read/write ladder and outside homileo.chat, so neither
        // homileo.spaces.read nor homileo.chat.admin implies it.
        name: READ_PRIVATE_PERMISSION,
        displayName: "Receive private messages",
        description:
          "Receive webhook events of DMs, space-less groups and members-only sessions, message bodies included",
        orgAssignable: true,
      },
      {
        // Off the homileo.spaces ladder, so `canReadChat` and `canWriteChat` name it.
        name: CHAT_ADMIN_PERMISSION,
        displayName: "Administer chat",
        description:
          "Administer every space and session of the organization, without reading its DMs; also grants Read spaces and Use spaces",
        orgAssignable: true,
      },
    ],
    systemRoles: [
      {
        name: "homileo_user",
        displayName: "Homileo user",
        description: "Takes part in chat",
        permissions: [SPACES_WRITE_PERMISSION],
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
      readPermission: privateTypes.has(eventType)
        ? READ_PRIVATE_PERMISSION
        : SPACES_READ_PERMISSION,
    })),
  },
});
