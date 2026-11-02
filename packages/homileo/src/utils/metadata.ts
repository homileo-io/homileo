import { z } from "zod";

export const METADATA_MAX_KEYS = 50;
export const METADATA_MAX_BYTES = 16 * 1024;
export const JSON_MAX_DEPTH = 32;

const withinDepth = (value: unknown, depth: number): boolean => {
  if (typeof value !== "object" || value === null) return true;
  if (depth >= JSON_MAX_DEPTH) return false;
  return Object.values(value).every((v) => withinDepth(v, depth + 1));
};

/**
 * Any JSON value nested at most `JSON_MAX_DEPTH` arrays and objects deep. The
 * depth is checked first: `z.json()` recurses, and a few thousand levels
 * overflow the stack.
 */
export const boundedJson = () =>
  z
    .unknown()
    .refine((v) => withinDepth(v, 0), {
      message: `At most ${JSON_MAX_DEPTH} levels of nesting`,
      abort: true,
    })
    .pipe(z.json());

/**
 * A flat object of at most 50 keys and 16 KiB serialized; values may be any
 * JSON. The keys are counted first, so a body of thousands of bad keys gets
 * one issue, not one per key.
 */
export const metadataSchema: z.ZodType<Record<string, unknown>> = z
  .record(z.string(), z.unknown())
  .refine((m) => Object.keys(m).length <= METADATA_MAX_KEYS, {
    message: `At most ${METADATA_MAX_KEYS} keys`,
    abort: true,
  })
  .pipe(
    z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/), boundedJson())
  )
  .refine((m) => Buffer.byteLength(JSON.stringify(m)) <= METADATA_MAX_BYTES, {
    message: "At most 16 KiB serialized",
  });
