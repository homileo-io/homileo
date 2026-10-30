import { z } from "zod";

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const APP = /^[a-z][a-z0-9-]{0,62}$/;
const STATE = /^[a-z][a-z0-9_]{0,62}$/;
// The registries' name columns hold 64 characters.
const NAME_MAX = 64;

const nameOf = (what: string) =>
  z
    .string()
    .max(NAME_MAX)
    .regex(
      /^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9_-]*$/,
      `${what} must be "<app>:<slug>"`
    );

const SpaceKindDeclarationSchema = z.strictObject({
  name: nameOf("a kind name"),
  defaults: z.strictObject({
    visibility: z.enum(["public", "members"]),
    join: z.enum(["open", "request", "invite"]),
    posting: z.enum(["members", "moderators"]),
  }),
  overridable: z.array(z.enum(["visibility", "join", "posting"])).optional(),
  states: z
    .array(z.string().regex(STATE))
    .refine((states) => new Set(states).size === states.length, {
      message: "states must be unique",
    })
    .optional(),
  grants: z
    .array(
      z.strictObject({
        permission: z.string().min(1),
        access: z.enum(["read", "moderate"]),
      })
    )
    .optional(),
  bots: z.array(z.uuid()).optional(),
  editWindowSeconds: z.number().int().min(0).nullable().optional(),
  search: z
    .strictObject({ metadata: z.array(z.string().min(1).max(64)) })
    .optional(),
});

const MessageTypeDeclarationSchema = z.strictObject({
  name: nameOf("a message type name"),
  // Compiled as JSON Schema 2020-12 when the set is validated.
  payloadSchema: z.record(z.string(), z.unknown()),
});

/** One Homileo provisioning document. The prefix rules need the whole document, so they live here. */
export const provisioningDocumentSchema = z
  .strictObject({
    // Lets an editor validate the file against provisioning.schema.json.
    $schema: z.string().optional(),
    version: z.string().regex(SEMVER, "version must be semver"),
    app: z.string().regex(APP),
    spaceKinds: z.array(SpaceKindDeclarationSchema).optional(),
    messageTypes: z.array(MessageTypeDeclarationSchema).optional(),
  })
  .superRefine((doc, ctx) => {
    const prefix = `${doc.app}:`;
    const check = (
      key: "spaceKinds" | "messageTypes",
      entries: { name: string }[] | undefined
    ) =>
      entries?.forEach((entry, i) => {
        if (!entry.name.startsWith(prefix))
          ctx.addIssue({
            code: "custom",
            path: [key, i, "name"],
            message: `must start with "${prefix}"`,
          });
      });
    check("spaceKinds", doc.spaceKinds);
    check("messageTypes", doc.messageTypes);
  });

export type HomileoProvisioningDocument = z.infer<
  typeof provisioningDocumentSchema
>;
export type SpaceKindDeclaration = z.infer<typeof SpaceKindDeclarationSchema>;
export type MessageTypeDeclaration = z.infer<
  typeof MessageTypeDeclarationSchema
>;

/**
 * The document's JSON Schema, for editors (`$schema`). The `<app>:` prefix
 * rule is a cross-field check JSON Schema cannot express; the server enforces it.
 */
export const provisioningJsonSchema = z.toJSONSchema(
  provisioningDocumentSchema,
  { io: "input" }
);
