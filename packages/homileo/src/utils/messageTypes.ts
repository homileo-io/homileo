import { BUILTIN_MESSAGE_TYPE } from "../definitions/builtins.js";
import { createPayloadAjv } from "./provisioning/validate.js";
import type { ErrorObject, ValidateFunction } from "ajv";
import { AppError, BadRequestError } from "./errors.js";
import { prisma, type Prisma } from "./db/prisma.js";

type Client = Prisma.TransactionClient | typeof prisma;

/** Other replicas re-provision on their own start; they pick the change up within this. */
const CACHE_TTL_MS = 60_000;

interface Compiled {
  validate: ValidateFunction;
  loadedAt: number;
}

const cache = new Map<string, Compiled>();

const issuesOf = (errors: ErrorObject[] | null | undefined) =>
  (errors ?? []).map((e) => ({
    path: ["payload", ...e.instancePath.split("/").slice(1)].join("."),
    message: e.message ?? "is invalid",
  }));

const invalidPayload = (
  message: string,
  issues: Array<{ path: string; message: string }>
) => new AppError(400, "invalid_payload", message, { details: { issues } });

/** An active type's compiled payload schema, or `null` for an unknown or retired type. */
const validatorFor = async (
  type: string,
  client: Client
): Promise<ValidateFunction | null> => {
  const cached = cache.get(type);
  if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) {
    return cached.validate;
  }
  const row = await client.provisionedMessageType.findUnique({
    where: { name: type },
    select: { payloadSchema: true, retiredAt: true },
  });
  if (!row || row.retiredAt !== null) {
    cache.delete(type);
    return null;
  }
  // An instance per schema: one Ajv would keep every version it compiled, and
  // refuse a changed schema that kept its `$id`.
  const validate = createPayloadAjv().compile(row.payloadSchema as object);
  cache.set(type, { validate, loadedAt: Date.now() });
  return validate;
};

/**
 * Checks `payload` against the type's provisioned schema. The built-in `text`
 * type takes no payload. Throws `400 message_type_not_found` for an unknown or
 * retired type and `400 invalid_payload` (with `issues`) for a payload that
 * fails its schema.
 */
export const validatePayload = async (
  type: string,
  payload: unknown,
  client: Client = prisma
): Promise<void> => {
  if (type === BUILTIN_MESSAGE_TYPE) {
    if (payload !== undefined) {
      throw invalidPayload("A text message takes no payload", [
        { path: "payload", message: "A text message takes no payload" },
      ]);
    }
    return;
  }
  const validate = await validatorFor(type, client);
  if (!validate) {
    throw new BadRequestError(
      "message_type_not_found",
      `No message type "${type}" is declared`
    );
  }
  if (!validate(payload)) {
    throw invalidPayload(
      `The payload does not match the schema of "${type}"`,
      issuesOf(validate.errors)
    );
  }
};

/** Drops the compiled schemas: provisioning changed the message types. */
export const invalidateMessageTypes = (): void => {
  cache.clear();
};
