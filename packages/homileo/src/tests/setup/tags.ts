import type { TestTagDefinition } from "vitest/config";

export const TIER_TAGS = ["unit", "int"] as const;
export const AREA_TAGS = [
  "auth",
  "spaces",
  "sessions",
  "messages",
  "events",
  "provisioning",
  "access",
  "platform",
] as const;
export const DETAIL_TAGS = [
  "race",
  "job",
  "security",
  "slow",
  "redis-outage",
] as const;
export const ASPECTS = [
  "validation",
  "permissions",
  "races",
  "audit",
  "limits",
  "errors",
] as const;
export const METHODS = ["get", "post", "put", "patch", "delete"] as const;

export type TierTag = (typeof TIER_TAGS)[number];
export type AreaTag = (typeof AREA_TAGS)[number];
export type DetailTag = (typeof DETAIL_TAGS)[number];

declare module "vitest" {
  interface TestTags {
    tag: TierTag | AreaTag | DetailTag;
  }
}

export const TAGS: TestTagDefinition[] = [
  { name: "unit", description: "Runs with no database, Redis or server" },
  {
    name: "int",
    description: "Runs against the real server, Postgres and Redis",
  },
  {
    name: "auth",
    description: "Principals, organizations and tokens",
  },
  { name: "spaces", description: "Spaces and their members" },
  { name: "sessions", description: "Chat sessions and their participants" },
  {
    name: "messages",
    description: "Messages, threads, reactions and mentions",
  },
  { name: "events", description: "Change events and their delivery" },
  {
    name: "provisioning",
    description: "Provisioning documents and the tereo declaration",
  },
  { name: "access", description: "The access policy module" },
  { name: "platform", description: "Health, startup and shutdown" },
  { name: "race", description: "Concurrent requests or processes" },
  { name: "job", description: "Background jobs and schedulers" },
  { name: "security", description: "Security properties and attack paths" },
  {
    name: "slow",
    description: "Takes long; raises the test timeout",
    timeout: 120_000,
  },
  { name: "redis-outage", description: "Behaviour while Redis is unavailable" },
];

/**
 * Areas a test file may carry, by path under `src/tests`. The longest
 * matching prefix wins; a path matching none accepts any area.
 */
export const AREA_BY_PATH: ReadonlyArray<
  readonly [prefix: string, area: AreaTag]
> = [
  ["routes/v1/me", "auth"],
  ["routes/v1/spaces", "spaces"],
  ["routes/v1/sessions", "sessions"],
  ["routes/v1/messages", "messages"],
  ["routes/v1/threads", "messages"],
  ["routes/v1/principals", "auth"],
  ["utils/access", "access"],
  ["utils/kinds", "provisioning"],
  ["middleware/auth", "auth"],
  ["policy", "access"],
  ["utils/provisioning", "provisioning"],
  ["cli", "provisioning"],
  ["utils/changes", "events"],
  ["jobs/eventPartitions", "events"],
  ["routes/health", "platform"],
  ...AREA_TAGS.map((a) => [`flows/${a}`, a] as const),
];
