import { z } from "zod";

export const METADATA_MAX_KEYS = 50;
export const METADATA_MAX_BYTES = 16 * 1024;

/** A flat object of at most 50 keys and 16 KiB serialized; values may be any JSON. */
export const metadataSchema: z.ZodType<Record<string, unknown>> = z
  .record(z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/), z.json())
  .refine((m) => Object.keys(m).length <= METADATA_MAX_KEYS, {
    message: `At most ${METADATA_MAX_KEYS} keys`,
  })
  .refine((m) => Buffer.byteLength(JSON.stringify(m)) <= METADATA_MAX_BYTES, {
    message: "At most 16 KiB serialized",
  });
