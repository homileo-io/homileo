// @module-tag int
// @module-tag websocket
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Principal } from "../../../prisma/generated/client/index.js";
import { chatFixtures } from "../support/chatFixtures.js";
import { personToken } from "../support/tokens.js";
import { v7 as uuidv7 } from "uuid";
import {
  noEvent,
  nextEvent,
  openSocket,
  request,
  startSocketServer,
  type ClientSocket,
  type LocalSocketServer,
} from "../support/sockets.js";

const fixtures = chatFixtures();
let local: LocalSocketServer;
const opened: ClientSocket[] = [];

const connectAs = async (who: Principal, org: string) => {
  const socket = await openSocket(
    personToken({ userId: who.tereoUserId!, org }),
    local.url
  );
  opened.push(socket);
  return socket;
};

beforeAll(async () => {
  local = await startSocketServer();
});

afterEach(() => {
  for (const socket of opened.splice(0)) socket.close();
});

afterAll(async () => {
  await local.close();
  await fixtures.cleanup();
});

const pair = async () => {
  const org = uuidv7();
  const [alice, bob] = [await fixtures.principal(), await fixtures.principal()];
  const session = await fixtures.session({ org, type: "group" });
  await fixtures.participant(session, alice);
  await fixtures.participant(session, bob);
  return {
    org,
    alice,
    bob,
    session,
    aliceSocket: await connectAs(alice, org),
    bobSocket: await connectAs(bob, org),
  };
};

describe("typing", () => {
  it("reaches the other participant with its expiry, and not the sender", async () => {
    const { alice, session, aliceSocket, bobSocket } = await pair();
    const received = nextEvent(bobSocket, "typing");
    const echoed = noEvent(aliceSocket, "typing");

    const ack = await request(aliceSocket, "typing.start", {
      sessionId: session.id,
    });

    expect(ack).toEqual({ ok: true });
    expect(await received).toEqual({
      sessionId: session.id,
      principalId: alice.id,
      typing: true,
      expiresInMs: 6000,
    });
    await echoed;
  });

  it("broadcasts typing.stop with typing false", async () => {
    const { alice, session, aliceSocket, bobSocket } = await pair();
    const received = nextEvent(bobSocket, "typing");

    const ack = await request(aliceSocket, "typing.stop", {
      sessionId: session.id,
    });

    expect(ack).toEqual({ ok: true });
    expect(await received).toEqual({
      sessionId: session.id,
      principalId: alice.id,
      typing: false,
      expiresInMs: 6000,
    });
  });

  it("acks not_found to a reader who is not a participant, and broadcasts nothing", async () => {
    const { org, bobSocket } = await pair();
    const space = await fixtures.space({ org, visibility: "public" });
    const session = await fixtures.session({ space, access: "space" });
    const outsider = await connectAs(await fixtures.principal(), org);
    expect(
      await request(outsider, "subscribe", { sessionId: session.id })
    ).toEqual({ ok: true });
    expect(
      await request(bobSocket, "subscribe", { sessionId: session.id })
    ).toEqual({ ok: true });
    const heard = noEvent(bobSocket, "typing");

    const ack = await request(outsider, "typing.start", {
      sessionId: session.id,
    });

    expect(ack).toMatchObject({ ok: false, error: { code: "not_found" } });
    await heard;
  });

  it("acks not_found for a session that does not exist, invalid_request for junk", async () => {
    const { aliceSocket } = await pair();

    expect(
      await request(aliceSocket, "typing.start", { sessionId: uuidv7() })
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(
      await request(aliceSocket, "typing.start", { sessionId: "nope" })
    ).toMatchObject({ ok: false, error: { code: "invalid_request" } });
  });

  it("acks a second typing.start within 2 s but does not rebroadcast it", async () => {
    const { session, aliceSocket, bobSocket } = await pair();
    const first = nextEvent(bobSocket, "typing");
    await request(aliceSocket, "typing.start", { sessionId: session.id });
    await first;
    const second = noEvent(bobSocket, "typing", 500);

    const ack = await request(aliceSocket, "typing.start", {
      sessionId: session.id,
    });

    expect(ack).toEqual({ ok: true });
    await second;
  });

  it("broadcasts typing.stop even right after a start", async () => {
    const { session, aliceSocket, bobSocket } = await pair();
    const first = nextEvent(bobSocket, "typing");
    await request(aliceSocket, "typing.start", { sessionId: session.id });
    await first;
    const stop = nextEvent<{ typing: boolean }>(bobSocket, "typing");

    await request(aliceSocket, "typing.stop", { sessionId: session.id });

    expect((await stop).typing).toBe(false);
  });
});
