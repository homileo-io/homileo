// @module-tag int
// @module-tag websocket
import { afterEach, describe, expect, it } from "vitest";
import { redis } from "../../utils/redis.js";
import { v7 as uuidv7 } from "uuid";
import {
  expire,
  goOffline,
  heartbeat,
  statuses,
} from "../../utils/presence.js";

const orgs: string[] = [];
const newOrg = () => {
  const org = uuidv7();
  orgs.push(org);
  return org;
};

afterEach(async () => {
  for (const org of orgs.splice(0)) await redis.del(`homileo:presence:${org}`);
});

describe("presence", () => {
  it("reports coming online only on the first heartbeat", async () => {
    const org = newOrg();
    const who = uuidv7();

    expect(await heartbeat(org, who)).toBe(true);
    expect(await heartbeat(org, who)).toBe(false);
    expect(await statuses(org, [who])).toEqual({ [who]: "online" });
  });

  it("keeps organizations apart", async () => {
    const [a, b] = [newOrg(), newOrg()];
    const who = uuidv7();
    await heartbeat(a, who);

    expect(await statuses(b, [who])).toEqual({ [who]: "offline" });
  });

  it("counts a stale entry as offline and its next heartbeat as coming online", async () => {
    const org = newOrg();
    const who = uuidv7();
    const start = Date.now();
    await heartbeat(org, who, start);

    expect(await statuses(org, [who], start + 59_000)).toEqual({
      [who]: "online",
    });
    expect(await statuses(org, [who], start + 61_000)).toEqual({
      [who]: "offline",
    });
    expect(await heartbeat(org, who, start + 62_000)).toBe(true);
  });

  it("goOffline removes once", async () => {
    const org = newOrg();
    const who = uuidv7();
    await heartbeat(org, who);

    expect(await goOffline(org, who)).toBe(true);
    expect(await goOffline(org, who)).toBe(false);
    expect(await statuses(org, [who])).toEqual({ [who]: "offline" });
  });

  it("expire removes entries 60 s past their heartbeat, and each only once across callers", async () => {
    const org = newOrg();
    const [old, fresh] = [uuidv7(), uuidv7()];
    const start = Date.now();
    await heartbeat(org, old, start);
    await heartbeat(org, fresh, start + 50_000);

    const [first, second] = await Promise.all([
      expire(org, start + 61_000),
      expire(org, start + 61_000),
    ]);

    expect([...first, ...second]).toEqual([{ org, principalId: old }]);
    expect(await statuses(org, [old, fresh], start + 61_000)).toEqual({
      [old]: "offline",
      [fresh]: "online",
    });
  });

  it("finds every organization's key when none is named", async () => {
    const [a, b] = [newOrg(), newOrg()];
    const [x, y] = [uuidv7(), uuidv7()];
    const start = Date.now();
    await heartbeat(a, x, start);
    await heartbeat(b, y, start);

    const removed = await expire(undefined, start + 61_000);

    expect(removed).toEqual(
      expect.arrayContaining([
        { org: a, principalId: x },
        { org: b, principalId: y },
      ])
    );
  });
});
