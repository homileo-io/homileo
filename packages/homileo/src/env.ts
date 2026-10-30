import "./preload.js";
import { z } from "zod";

// The one env schema for the whole service.
//
// Values are read from the real environment (and `.env` via preload). Nothing
// rewrites URLs per runtime context, so local and test runs set DATABASE_URL
// and REDIS_URL explicitly.

const DEV_PUBLIC_URL = "http://localhost:4101";

const corsOrigins = z.string().transform((val) =>
  val === "*"
    ? ("*" as const)
    : val
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
);

/**
 * The environment as the schema reads it. An empty value is unset, so its
 * default applies: `FOO=` in a .env, or compose's `FOO: ${FOO}` with FOO
 * unset, must not coerce to 0 or "".
 */
const prepareEnv = (input: unknown): unknown => {
  if (typeof input !== "object" || input === null) return input;
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== "")
  );
};

/** An integer setting within [min, max]: a duration, a count or a port. */
const int = (min: number, max: number, fallback: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

const bool = (fallback: "true" | "false") =>
  z
    .string()
    .default(fallback)
    .transform((val) => val === "true" || val === "1");

/** Needed to reach tereo; test mode runs without it. */
const TEREO_CONNECTION = [
  "TEREO_URL",
  "TEREO_CLIENT_ID",
  "TEREO_CLIENT_SECRET",
  "REQUEST_HANDLER_KEY",
] as const;

const EnvFields = z
  .object({
    NODE_ENV: z
      .enum(["development", "production", "test"])
      .default("development"),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    // `all` runs HTTP and background work in one process; `api` and `worker`
    // split them so each can be scaled on its own.
    ROLE: z.enum(["all", "api", "worker"]).default("all"),
    PORT: int(1, 65535, 4101),
    // Externally reachable base URL of this service. Required in production.
    PUBLIC_URL: z.string().url().optional(),
    DATABASE_URL: z.string(),
    REDIS_URL: z.string(),
    // Postgres connections per process.
    DB_POOL_MAX: int(1, 1000, 10),
    DB_POOL_MIN: int(0, 1000, 0),
    // How long a query waits for a free connection before it fails.
    DB_POOL_CONNECTION_TIMEOUT_MS: int(100, 600_000, 5000),
    // Express `trust proxy`: a hop count, a CIDR list, a named range, or
    // "true" / "false". "true" is refused in production, where it lets
    // clients choose their IP.
    TRUST_PROXY: z.string().default("false"),
    // Defaults to PUBLIC_URL.
    CORS_ORIGINS: corsOrigins.optional(),
    // On SIGTERM, how long in-flight requests and running jobs get before
    // they are cut off.
    SHUTDOWN_TIMEOUT_SECONDS: int(1, 3600, 25),
    // The tereo core this service is an app service of, and the credentials
    // it reaches it with.
    TEREO_URL: z.string().url().optional(),
    TEREO_CLIENT_ID: z.string().optional(),
    TEREO_CLIENT_SECRET: z.string().optional(),
    // Verifies the requests tereo's request handler forwards to this service.
    REQUEST_HANDLER_KEY: z.string().optional(),
    // Accepts the SDK's test tokens instead of tereo's. Refused in production.
    TEREO_TEST_MODE: bool("false"),
    TEREO_SERVICE_SLUG: z.string().min(1).default("homileo"),
    // A folder of provisioning documents applied on every start.
    PROVISIONING_PATH: z.string().optional(),
    // How long change events are kept.
    EVENT_RETENTION_DAYS: int(1, 3650, 30),
    // How long creating an event partition waits for the table's lock before
    // the next run retries.
    PARTITION_DDL_LOCK_TIMEOUT_MS: int(100, 60_000, 5_000),
    // How long a cached principal profile lives.
    PRINCIPAL_PROFILE_TTL_SECONDS: int(1, 86_400, 3600),
  })
  .superRefine((val, ctx) => {
    if (val.NODE_ENV === "production" && val.TEREO_TEST_MODE) {
      ctx.addIssue({
        code: "custom",
        path: ["TEREO_TEST_MODE"],
        message: "TEREO_TEST_MODE is refused in production",
      });
    }
    if (!val.TEREO_TEST_MODE) {
      for (const name of TEREO_CONNECTION) {
        if (!val[name]) {
          ctx.addIssue({
            code: "custom",
            path: [name],
            message: `${name} is required unless TEREO_TEST_MODE is set`,
          });
        }
      }
    }
    if (val.DB_POOL_MIN > val.DB_POOL_MAX) {
      ctx.addIssue({
        code: "custom",
        path: ["DB_POOL_MIN"],
        message: "DB_POOL_MIN must not exceed DB_POOL_MAX",
      });
    }
    if (val.NODE_ENV === "production") {
      if (!val.PUBLIC_URL) {
        ctx.addIssue({
          code: "custom",
          path: ["PUBLIC_URL"],
          message: "PUBLIC_URL is required in production",
        });
      }
      if (val.TRUST_PROXY === "true") {
        ctx.addIssue({
          code: "custom",
          path: ["TRUST_PROXY"],
          message:
            "TRUST_PROXY cannot be 'true' in production (it lets clients choose their IP): use a hop count, a CIDR list, 'loopback' or 'false'",
        });
      }
    }
  })
  .transform((raw) => {
    const publicUrl = (raw.PUBLIC_URL ?? DEV_PUBLIC_URL).replace(/\/+$/, "");
    return {
      ...raw,
      PUBLIC_URL: publicUrl,
      CORS_ORIGINS: raw.CORS_ORIGINS ?? [new URL(publicUrl).origin],
      SERVICE_NAME: "homileo" as const,
    };
  });

export const EnvSchema = z.preprocess(prepareEnv, EnvFields);

export type Env = z.infer<typeof EnvFields>;

export const parseEnv = (input: unknown): Env => EnvSchema.parse(input) as Env;

export default parseEnv(process.env);
