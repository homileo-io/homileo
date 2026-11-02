// @module-tag int
// @module-tag websocket
// @module-tag events
import { sessionRoom, spaceRoom } from "../../realtime/rooms.js";
import { publishCommitted } from "../../utils/changeBus.js";
import type { ChangeEvent } from "../../utils/changes.js";
import { chatFixtures } from "../support/chatFixtures.js";
import type { JsonResponse } from "../support/http.js";
import { personToken } from "../support/tokens.js";
import { prisma } from "../../utils/db/prisma.js";
import { v7 as uuidv7 } from "uuid";
import {
  eventually,
  nextEvent,
  noEvent,
  openLocalSocket,
  request,
  startSocketServer,
  SUBSCRIBED,
  type ClientSocket,
  type LocalSocketServer,
} from "../support/sockets.js";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const fixtures = chatFixtures();
let local: LocalSocketServer;
const opened: ClientSocket[] = [];

beforeAll(async () => {
  local = await startSocketServer({ fanout: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const socket of opened.splice(0)) socket.close();
});

afterAll(async () => {
  await local.close();
  await fixtures.cleanup();
});

const event = (
  o: Pick<ChangeEvent, "type" | "organizationId" | "payload"> &
    Partial<ChangeEvent>
): ChangeEvent => ({
  id: BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000)),
  createdAt: new Date(),
  spaceId: null,
  sessionId: null,
  actorId: uuidv7(),
  ...o,
});

describe("startFanout failures", () => {
  it("still pushes the rest of a batch when re-checking an earlier event's sockets fails", async () => {
    const org = uuidv7();
    const who = await fixtures.principal();
    const session = await fixtures.session({ org, type: "group" });
    await fixtures.participant(session, who);
    const socket = await openLocalSocket(
      personToken({ userId: who.tereoUserId!, org }),
      local
    );
    opened.push(socket);
    // A node that does not answer in time.
    vi.spyOn(local.io.of("/").adapter, "fetchSockets").mockRejectedValueOnce(
      new Error("timeout reached: only 0 responses received out of 1")
    );
    const arriving = nextEvent<JsonResponse["body"]>(socket, "message.created");

    const messageId = uuidv7();
    publishCommitted([
      event({
        type: "session.access_revoked",
        organizationId: org,
        payload: { principalId: who.id, sessionId: session.id },
      }),
      event({
        type: "message.created",
        organizationId: org,
        sessionId: session.id,
        payload: { message: { id: messageId } },
      }),
    ]);

    expect((await arriving).payload.message.id).toBe(messageId);
    expect(local.io.of("/").adapter.fetchSockets).toHaveBeenCalled();
  });
});

describe("startFanout joins", () => {
  it("joins this node's sockets before the emit even when Redis drops the adapter's join", async () => {
    const org = uuidv7();
    const who = await fixtures.principal();
    const session = await fixtures.session({ org, type: "group" });
    const socket = await openLocalSocket(
      personToken({ userId: who.tereoUserId!, org }),
      local
    );
    opened.push(socket);
    await fixtures.participant(session, who);
    // The adapter's join travels through Redis; here it never arrives.
    vi.spyOn(local.io.of("/").adapter, "addSockets").mockImplementation(
      () => undefined
    );
    const arriving = nextEvent<JsonResponse["body"]>(socket, "message.created");

    const messageId = uuidv7();
    publishCommitted([
      event({
        type: "session.participant_added",
        organizationId: org,
        sessionId: session.id,
        payload: {
          sessionId: session.id,
          participant: { principalId: who.id },
        },
      }),
      event({
        type: "message.created",
        organizationId: org,
        sessionId: session.id,
        payload: { message: { id: messageId } },
      }),
    ]);

    expect((await arriving).payload.message.id).toBe(messageId);
  });
});

describe("startFanout update re-check failures", () => {
  /** A public space turned members-only, with a member's and a subscribed outsider's sockets. */
  const narrowedSpace = async () => {
    const org = uuidv7();
    const space = await fixtures.space({ org, visibility: "public" });
    const member = await fixtures.principal();
    const outsider = await fixtures.principal();
    await fixtures.member(space, member);
    const inside = await openLocalSocket(
      personToken({ userId: member.tereoUserId!, org }),
      local
    );
    const outside = await openLocalSocket(
      personToken({ userId: outsider.tereoUserId!, org }),
      local
    );
    opened.push(inside, outside);
    expect(await request(outside, "subscribe", { spaceId: space.id })).toEqual(
      SUBSCRIBED
    );
    await prisma.space.update({
      where: { id: space.id },
      data: { visibility: "members" },
    });
    const updated = event({
      type: "space.updated",
      organizationId: org,
      spaceId: space.id,
      payload: {
        space: { id: space.id, visibility: "members" },
        previousVisibility: "public",
      },
    });
    return { space, inside, outside, updated };
  };

  const adapterOf = () => local.io.of("/").adapter;

  it("re-checks this node's sockets and sends only to them when other nodes cannot be reached", async () => {
    const { space, inside, outside, updated } = await narrowedSpace();
    const adapter = adapterOf();
    const original = adapter.fetchSockets.bind(adapter);
    vi.spyOn(adapter, "fetchSockets").mockImplementation((opts) =>
      opts.flags?.local
        ? original(opts)
        : Promise.reject(new Error("timeout reached"))
    );
    const silent = noEvent(outside, "space.updated", 500);
    const arriving = nextEvent(inside, "space.updated");

    publishCommitted([updated]);

    await arriving;
    await silent;
    expect(
      local.io.of("/").sockets.get(outside.id!)?.rooms.has(spaceRoom(space.id))
    ).toBe(false);
  });

  it("sends the update to no socket in the rooms when no re-check succeeds", async () => {
    const { inside, outside, updated } = await narrowedSpace();
    vi.spyOn(adapterOf(), "fetchSockets").mockRejectedValue(
      new Error("database down")
    );
    const silentOutside = noEvent(outside, "space.updated", 500);
    const silentInside = noEvent(inside, "space.updated", 500);

    publishCommitted([updated]);

    await silentOutside;
    await silentInside;
  });
});

describe("startFanout loss of access when other nodes cannot be reached", () => {
  /** A participant's socket on this node, and cluster fetches that fail. */
  const unreachable = async () => {
    const org = uuidv7();
    const who = await fixtures.principal();
    const session = await fixtures.session({ org, type: "group" });
    await fixtures.participant(session, who);
    const socket = await openLocalSocket(
      personToken({ userId: who.tereoUserId!, org }),
      local
    );
    opened.push(socket);
    const adapter = local.io.of("/").adapter;
    const original = adapter.fetchSockets.bind(adapter);
    vi.spyOn(adapter, "fetchSockets").mockImplementation((opts) =>
      opts.flags?.local
        ? original(opts)
        : Promise.reject(new Error("timeout reached"))
    );
    const inRoom = () =>
      local.io
        .of("/")
        .sockets.get(socket.id!)
        ?.rooms.has(sessionRoom(session.id));
    expect(inRoom()).toBe(true);
    return { org, who, session, socket, inRoom };
  };

  it("still takes this node's sockets out of the room on a removal", async () => {
    const { org, who, session, socket, inRoom } = await unreachable();
    const removed = nextEvent(socket, "session.participant_removed");

    publishCommitted([
      event({
        type: "session.participant_removed",
        organizationId: org,
        sessionId: session.id,
        payload: { sessionId: session.id, principalId: who.id },
      }),
    ]);

    await removed;
    await eventually(() => inRoom() === false);
  });

  it("still re-checks this node's sockets and tells them on a revocation", async () => {
    const { org, who, session, socket, inRoom } = await unreachable();
    await prisma.sessionParticipant.updateMany({
      where: { sessionId: session.id, userId: who.id },
      data: { leftAt: new Date() },
    });
    const revoked = nextEvent(socket, "session.access_revoked");

    publishCommitted([
      event({
        type: "session.access_revoked",
        organizationId: org,
        payload: { principalId: who.id, sessionId: session.id },
      }),
    ]);

    await revoked;
    expect(inRoom()).toBe(false);
  });
});
