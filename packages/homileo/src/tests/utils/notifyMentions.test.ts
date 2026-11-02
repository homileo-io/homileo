// @module-tag int
// @module-tag messages
import type { MentionedPrincipal } from "../../utils/db/messages.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cooldownRedis, redis } from "../../utils/redis.js";
import { v7 as uuidv7 } from "uuid";
import {
  mentionCooldownKey,
  outOfCooldown,
} from "../../utils/notifyMentions.js";

const keys: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  if (keys.length > 0) await redis.del(keys.splice(0));
  if (cooldownRedis.status !== "ready") {
    await new Promise((resolve) => cooldownRedis.once("ready", resolve));
  }
});

const readers = (n: number): MentionedPrincipal[] =>
  Array.from({ length: n }, () => ({
    id: uuidv7(),
    displayName: null,
    tereoUserId: uuidv7(),
    isBot: false,
    participantRole: "member",
    notify: "all",
    spaceRole: null,
  }));

const track = (senderId: string, rs: MentionedPrincipal[]) =>
  keys.push(...rs.map((r) => mentionCooldownKey(senderId, r.id)));

describe("outOfCooldown", () => {
  it("takes the first readers out of cooldown, up to the cap, and starts only theirs", async () => {
    const sender = uuidv7();
    const rs = readers(6);
    track(sender, rs);
    await redis.set(mentionCooldownKey(sender, rs[1]!.id), "1", "EX", 60);

    const taken = await outOfCooldown(sender, rs, 3);

    expect(taken.map((r) => r.id)).toEqual([rs[0]!.id, rs[2]!.id, rs[3]!.id]);
    expect(await redis.exists(mentionCooldownKey(sender, rs[4]!.id))).toBe(0);
    expect((await outOfCooldown(sender, rs, 3)).map((r) => r.id)).toEqual([
      rs[4]!.id,
      rs[5]!.id,
    ]);
  });

  it("skips the cooldown when Redis is slow, and the late command sets no keys", async () => {
    const sender = uuidv7();
    const rs = readers(4);
    track(sender, rs);
    const list = `${uuidv7()}:blocked`;
    keys.push(list);
    const clientId = (await cooldownRedis.client("ID")) as number;
    // Holds the connection server-side, so the cooldown queues behind it.
    cooldownRedis.blpop(list, 5).catch(() => {});

    expect(await outOfCooldown(sender, rs, 3)).toEqual(rs.slice(0, 3));

    // Wait for Redis to drop the old connection, then end the block: a
    // command still queued on it would run now.
    for (let i = 0; i < 50; i++) {
      const listed = (await redis.client("LIST", "ID", clientId)) as string;
      if (listed === "") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await redis.lpush(list, "x");
    const set = await Promise.all(
      rs.map((r) => redis.exists(mentionCooldownKey(sender, r.id)))
    );
    expect(set).toEqual([0, 0, 0, 0]);
  });

  it("does not send a command cut off by a dropped connection again", async () => {
    const key = `${uuidv7()}:resent`;
    keys.push(key);
    const list = `${uuidv7()}:blocked`;
    keys.push(list);
    cooldownRedis.blpop(list, 5).catch(() => {});
    const set = cooldownRedis.set(key, "1").then(
      () => "set",
      (err: Error) => err.message
    );
    // Drops the socket under both commands; ioredis reconnects.
    cooldownRedis.stream.destroy();

    expect(await set).not.toBe("set");
    await new Promise((resolve) => cooldownRedis.once("ready", resolve));
    await redis.lpush(list, "x");
    expect(await cooldownRedis.ping()).toBe("PONG");
    expect(await redis.exists(key)).toBe(0);
  });

  it("skips the cooldown when Redis fails", async () => {
    const sender = uuidv7();
    const rs = readers(2);
    vi.spyOn(cooldownRedis, "eval").mockRejectedValue(new Error("down"));

    expect(await outOfCooldown(sender, rs, 3)).toEqual(rs);
  });
});
