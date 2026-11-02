// @module-tag int
// @module-tag websocket
// @module-tag auth
import { openSocket, request, type ClientSocket } from "../support/sockets.js";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { chatFixtures } from "../support/chatFixtures.js";
import { personToken } from "../support/tokens.js";
import { v7 as uuidv7 } from "uuid";

const fixtures = chatFixtures();
const opened: ClientSocket[] = [];

afterEach(() => {
  for (const socket of opened.splice(0)) socket.close();
});

afterAll(async () => {
  await fixtures.cleanup();
});

describe("typing with a token that has only homileo.spaces.read", () => {
  it.each(["typing.start", "typing.stop"])(
    "refuses %s with forbidden",
    async (event) => {
      const org = uuidv7();
      const who = await fixtures.principal();
      const session = await fixtures.session({ org, type: "group" });
      await fixtures.participant(session, who);
      const socket = await openSocket(
        personToken({
          userId: who.tereoUserId!,
          org,
          perms: ["homileo.spaces.read"],
        })
      );
      opened.push(socket);

      const ack = await request(socket, event, { sessionId: session.id });

      expect(ack).toMatchObject({ ok: false, error: { code: "forbidden" } });
    }
  );
});
