import { BUILTIN_MESSAGE_TYPE } from "../definitions/builtins.js";
import { createPayloadAjv } from "./provisioning/validate.js";
import type { ErrorObject, ValidateFunction } from "ajv";
import { AppError, BadRequestError } from "./errors.js";
import type { Prisma } from "./db/prisma.js";
import { db } from "./db/index.js";

type Tx = Prisma.TransactionClient;

interface Compiled {
  schema: string;
  validate: ValidateFunction;
}

// Keyed by type; reused while the row's schema text is unchanged.
const compiled = new Map<string, Compiled>();

// Even without `allErrors`, combinators such as `anyOf` report one failure per branch.
export const MAX_PAYLOAD_ISSUES = 20;

const issuesOf = (errors: ErrorObject[] | null | undefined) =>
  (errors ?? []).slice(0, MAX_PAYLOAD_ISSUES).map((e) => ({
    path: ["payload", ...e.instancePath.split("/").slice(1)].join("."),
    message: e.message ?? "is invalid",
  }));

const invalidPayload = (
  message: string,
  issues: Array<{ path: string; message: string }>
) => new AppError(400, "invalid_payload", message, { details: { issues } });

/**
 * An active type's compiled payload schema, or `null` for an unknown or retired
 * type. The row is read in `tx` under the type's shared advisory lock
 * (`db/provisioned.ts`): retiring the type waits for this transaction, or this
 * waits for the retirement and then finds the type retired.
 */
const validatorFor = async (
  tx: Tx,
  type: string
): Promise<ValidateFunction | null> => {
  await db.provisioned.holdShared(tx, "message_type", type);
  const rows = await tx.$queryRaw<Array<{ schema: string }>>`
    SELECT payload_schema::text AS schema
    FROM "chat"."provisioned_message_types"
    WHERE name = ${type} AND retired_at IS NULL`;
  const schema = rows[0]?.schema;
  if (schema === undefined) {
    compiled.delete(type);
    return null;
  }
  const cached = compiled.get(type);
  if (cached?.schema === schema) return cached.validate;
  // An instance per schema: one Ajv would keep every version it compiled, and
  // refuse a changed schema that kept its `$id`.
  const validate = createPayloadAjv().compile(JSON.parse(schema) as object);
  compiled.set(type, { schema, validate });
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
  tx: Tx
): Promise<void> => {
  if (type === BUILTIN_MESSAGE_TYPE) {
    if (payload !== undefined) {
      throw invalidPayload("A text message takes no payload", [
        { path: "payload", message: "A text message takes no payload" },
      ]);
    }
    return;
  }
  const validate = await validatorFor(tx, type);
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
  compiled.clear();
};
