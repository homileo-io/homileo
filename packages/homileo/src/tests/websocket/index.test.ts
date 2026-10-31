// @module-tag int
// @module-tag websocket
// @module-tag race
import { afterAll, afterEach, beforeAll, describe, it, vi } from "vitest";
import { chatFixtures } from "../support/chatFixtures.js";
import { roomsOnConnect } from "../../websocket/rooms.js";
import type * as rooms from "../../websocket/rooms.js";
import { sessionRoom } from "../../realtime/rooms.js";
import { personToken } from "../support/tokens.js";
import { v7 as uuidv7 } from "uuid";
import {
  eventually,
  openSocket,
  startSocketServer,
  type ClientSocket,
  type LocalSocketServer,
} from "../support/sockets.js";

vi.mock("../../websocket/rooms.js", async (importOriginal) => {
  const original = await importOriginal<typeof rooms>();
  return { ...original, roomsOnConnect: vi.fn(original.roomsOnConnect) };
});

const fixtures = chatFixtures();
let local: LocalSocketServer;
const opened: ClientSocket[] = [];

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

describe("createSocketServer", () => {
  it("re-checks a new socket's rooms after joining them, for access lost since the handshake loaded them", async () => {
    const org = uuidv7();
    const who = await fixtures.principal();
    const space = await fixtures.space({ org, visibility: "members" });
    const session = await fixtures.session({ space, access: "space" });
    // As if the handshake read a participation that was removed before the joins.
    vi.mocked(roomsOnConnect).mockImplementationOnce(async (c) => [
      ...(await vi
        .importActual<typeof rooms>("../../websocket/rooms.js")
        .then((m) => m.roomsOnConnect(c))),
      sessionRoom(session.id),
    ]);

    const socket = await openSocket(
      personToken({ userId: who.tereoUserId!, org }),
      local.url
    );
    opened.push(socket);

    await eventually(
      () =>
        local.io
          .of("/")
          .sockets.get(socket.id!)
          ?.rooms.has(sessionRoom(session.id)) === false
    );
  });

  it("joins a participation added between the handshake's load and the joins", async () => {
    const org = uuidv7();
    const who = await fixtures.principal();
    const session = await fixtures.session({ org, type: "group" });
    await fixtures.participant(session, who);
    // As if the handshake read the participations just before this one was added.
    vi.mocked(roomsOnConnect).mockImplementationOnce(async (c) =>
      (
        await vi
          .importActual<typeof rooms>("../../websocket/rooms.js")
          .then((m) => m.roomsOnConnect(c))
      ).filter((room) => room !== sessionRoom(session.id))
    );

    const socket = await openSocket(
      personToken({ userId: who.tereoUserId!, org }),
      local.url
    );
    opened.push(socket);

    await eventually(
      () =>
        local.io
          .of("/")
          .sockets.get(socket.id!)
          ?.rooms.has(sessionRoom(session.id)) === true
    );
  });
});
