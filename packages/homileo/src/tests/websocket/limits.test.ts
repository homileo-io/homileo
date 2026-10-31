// @module-tag int
// @module-tag websocket
import { afterEach, describe, expect, it } from "vitest";
import { personToken } from "../support/tokens.js";
import { v7 as uuidv7 } from "uuid";
import {
  disconnected,
  openSocket,
  request,
  type ClientSocket,
} from "../support/sockets.js";

const opened: ClientSocket[] = [];
const open = async () => {
  const socket = await openSocket(personToken({ org: uuidv7() }));
  opened.push(socket);
  return socket;
};

afterEach(() => {
  for (const socket of opened.splice(0)) socket.close();
});

describe("socket limits", () => {
  it("closes a socket that sends a 32 KiB packet", async () => {
    const socket = await open();

    socket.emit("subscribe", { sessionId: "x".repeat(32 * 1024) });

    expect(await disconnected(socket)).toBe("transport close");
  });

  it("acks the 21st event in one second rate_limited", async () => {
    const socket = await open();

    const acks = await Promise.all(
      Array.from({ length: 21 }, () =>
        request(socket, "unsubscribe", { sessionId: uuidv7() })
      )
    );

    expect(acks.slice(0, 20)).toEqual(Array(20).fill({ ok: true }));
    expect(acks[20]).toEqual({
      ok: false,
      error: { code: "rate_limited", message: expect.any(String) },
    });
  });

  it("accepts events again once the second has passed", async () => {
    const socket = await open();
    await Promise.all(
      Array.from({ length: 21 }, () =>
        request(socket, "unsubscribe", { sessionId: uuidv7() })
      )
    );

    await new Promise((r) => setTimeout(r, 1100));

    expect(
      await request(socket, "unsubscribe", { sessionId: uuidv7() })
    ).toEqual({ ok: true });
  });
});
