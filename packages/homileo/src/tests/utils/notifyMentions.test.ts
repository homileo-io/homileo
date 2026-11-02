// @module-tag int
// @module-tag messages
import type { MentionedPrincipal } from "../../utils/db/messages.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { redis } from "../../utils/redis.js";
import { v7 as uuidv7 } from "uuid";
import {
  mentionCooldownKey,
  outOfCooldown,
} from "../../utils/notifyMentions.js";

const keys: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  if (keys.length > 0) await redis.del(keys.splice(0));
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

  it("skips the cooldown when Redis does not answer", async () => {
    const sender = uuidv7();
    const rs = readers(4);
    vi.spyOn(redis, "eval").mockReturnValue(
      new Promise<never>(() => {}) as never
    );

    expect(await outOfCooldown(sender, rs, 3)).toEqual(rs.slice(0, 3));
  });

  it("skips the cooldown when Redis fails", async () => {
    const sender = uuidv7();
    const rs = readers(2);
    vi.spyOn(redis, "eval").mockRejectedValue(new Error("down"));

    expect(await outOfCooldown(sender, rs, 3)).toEqual(rs);
  });
});
