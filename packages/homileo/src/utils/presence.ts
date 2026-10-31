import { redis } from "./redis.js";
import env from "../env.js";

/** A principal is offline this long after its last heartbeat. */
export const PRESENCE_TTL_MS = 60_000;

const KEY_PREFIX = `${env.SERVICE_NAME}:presence:`;
const key = (org: string) => `${KEY_PREFIX}${org}`;

// Read, write and decide in one step, so two heartbeats cannot both report coming online.
const HEARTBEAT = `
local old = redis.call('ZSCORE', KEYS[1], ARGV[2])
redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])
if (not old) or tonumber(old) <= tonumber(ARGV[1]) - tonumber(ARGV[3]) then return 1 end
return 0`;

// The members are read and removed together: of several nodes expiring the same key, each
// member comes back from exactly one.
const EXPIRE = `
local gone = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
if #gone > 0 then redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1]) end
return gone`;

/** Records a heartbeat; true when the principal was not online before it. */
export const heartbeat = async (
  org: string,
  principalId: string,
  now: number = Date.now()
): Promise<boolean> =>
  (await redis.eval(
    HEARTBEAT,
    1,
    key(org),
    now,
    principalId,
    PRESENCE_TTL_MS
  )) === 1;

export const statuses = async (
  org: string,
  ids: string[],
  now: number = Date.now()
): Promise<Record<string, "online" | "offline">> => {
  if (ids.length === 0) return {};
  const scores = await redis.zmscore(key(org), ...ids);
  return Object.fromEntries(
    ids.map((id, i) => {
      const score = scores[i];
      const online = score !== null && Number(score) > now - PRESENCE_TTL_MS;
      return [id, online ? "online" : "offline"] as const;
    })
  );
};

/** Removes the principal's entry; true when this call removed it. */
export const goOffline = async (
  org: string,
  principalId: string
): Promise<boolean> => (await redis.zrem(key(org), principalId)) === 1;

const orgKeys = async (org?: string): Promise<string[]> => {
  if (org) return [key(org)];
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [next, found] = await redis.scan(
      cursor,
      "MATCH",
      `${KEY_PREFIX}*`,
      "COUNT",
      100
    );
    cursor = next;
    keys.push(...found);
  } while (cursor !== "0");
  return keys;
};

/** Removes entries older than the TTL, in one organization or every one, and returns them. */
export const expire = async (
  org?: string,
  now: number = Date.now()
): Promise<Array<{ org: string; principalId: string }>> => {
  const removed: Array<{ org: string; principalId: string }> = [];
  for (const k of await orgKeys(org)) {
    const gone = (await redis.eval(
      EXPIRE,
      1,
      k,
      now - PRESENCE_TTL_MS
    )) as string[];
    for (const principalId of gone)
      removed.push({ org: k.slice(KEY_PREFIX.length), principalId });
  }
  return removed;
};
