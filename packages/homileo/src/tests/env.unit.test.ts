// @module-tag unit
// @module-tag platform
import { describe, expect, it } from "vitest";
import { parseEnv } from "../env.js";

const base = {
  DATABASE_URL: "postgresql://x/y",
  REDIS_URL: "redis://x",
  PUBLIC_URL: "http://localhost:4101",
};
const tereo = {
  TEREO_URL: "http://localhost:4001",
  TEREO_CLIENT_ID: "client",
  TEREO_CLIENT_SECRET: "secret",
  REQUEST_HANDLER_KEY: "key",
};

describe("env schema", () => {
  it("defaults ROLE to all, PORT to 4101 and EVENT_RETENTION_DAYS to 30", () => {
    const env = parseEnv({ ...base, TEREO_TEST_MODE: "true" });
    expect(env).toMatchObject({
      ROLE: "all",
      PORT: 4101,
      EVENT_RETENTION_DAYS: 30,
      PRINCIPAL_PROFILE_TTL_SECONDS: 3600,
      TEREO_SERVICE_SLUG: "homileo",
      TEREO_TEST_MODE: true,
      CORS_ORIGINS: ["http://localhost:4101"],
    });
  });

  it("treats an empty value as unset", () => {
    const env = parseEnv({ ...base, ...tereo, PORT: "", ROLE: "" });
    expect(env).toMatchObject({ PORT: 4101, ROLE: "all" });
  });

  it("refuses TEREO_TEST_MODE=true when NODE_ENV=production", () => {
    expect(() =>
      parseEnv({
        ...base,
        PUBLIC_URL: "https://chat.example.com",
        NODE_ENV: "production",
        TRUST_PROXY: "1",
        TEREO_TEST_MODE: "true",
      })
    ).toThrow(/TEREO_TEST_MODE/);
  });

  it.each([
    "TEREO_URL",
    "TEREO_CLIENT_ID",
    "TEREO_CLIENT_SECRET",
    "REQUEST_HANDLER_KEY",
  ])("requires %s unless TEREO_TEST_MODE", (name) => {
    const { [name as keyof typeof tereo]: _, ...rest } = tereo;
    expect(() => parseEnv({ ...base, ...rest })).toThrow(new RegExp(name));
    expect(() =>
      parseEnv({ ...base, ...rest, TEREO_TEST_MODE: "true" })
    ).not.toThrow();
  });
});
