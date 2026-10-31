// @module-tag int
// @module-tag websocket
// @module-tag access
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sessionRoom, spaceOfRoom, spaceRoom } from "../../realtime/rooms.js";
import { fetchJson, type JsonResponse } from "../support/http.js";
import { spaceApiFixtures } from "../support/spaceApi.js";
import { sendMessage } from "../support/messageApi.js";
import { startV1App } from "../support/v1App.js";
import { v7 as uuidv7 } from "uuid";
import {
  collect,
  eventually,
  noEvent,
  openLocalSocket,
  request,
  startSocketServer,
  SUBSCRIBED,
  type ClientSocket,
  type LocalSocketServer,
} from "../support/sockets.js";

const api = spaceApiFixtures();
const { fixtures } = api;
type Actor = Awaited<ReturnType<typeof api.actor>>;
let org = "";
let owner: Actor;
// The routes commit in this process, so `local` is the node that fans out; `other` is a
// second node sharing the Redis adapter, which only holds sockets.
let app: Awaited<ReturnType<typeof startV1App>>;
let local: LocalSocketServer;
let other: LocalSocketServer;
const opened: ClientSocket[] = [];

const connect = async (who: Actor, node: LocalSocketServer = local) => {
  const socket = await openLocalSocket(who.token, node);
  opened.push(socket);
  return socket;
};

const serverSocket = (socket: ClientSocket, node: LocalSocketServer) => {
  const found = node.io.of("/").sockets.get(socket.id!);
  if (!found) throw new Error("no server socket");
  return found;
};

const send = async (sessionId: string, who: Actor, body: string) => {
  const res = await sendMessage(sessionId, who.token, { body }, app.url);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
};

/** Each `types` event `socket` receives from now on, as `[type, principalId]`, in arrival order. */
const record = (socket: ClientSocket, types: string[]) => {
  const received: Array<[string, string]> = [];
  for (const type of types) {
    socket.on(type, (e: JsonResponse["body"]) =>
      received.push([type, e.payload.principalId])
    );
  }
  return received;
};

beforeAll(async () => {
  app = await startV1App();
  local = await startSocketServer({ fanout: true });
  other = await startSocketServer();
  org = api.organization();
  owner = await api.actor(org);
});

afterEach(() => {
  for (const socket of opened.splice(0)) socket.close();
});

afterAll(async () => {
  await other.close();
  await local.close();
  await app.close();
  await api.cleanup();
});

describe("startFanout losing access", () => {
  it.each([
    ["on the committing node", () => local],
    ["on another node", () => other],
  ])(
    "stops a removed member's subscribed socket getting the space's session events %s",
    async (_where, nodeOf) => {
      const node = nodeOf();
      const space = await fixtures.space({ org, visibility: "members" });
      const session = await fixtures.session({ space, access: "space" });
      await fixtures.member(space, owner.principal, "owner");
      await fixtures.participant(session, owner.principal, "owner");
      const alice = await api.actor(org);
      await fixtures.member(space, alice.principal);
      const socket = await connect(alice, node);
      expect(
        await request(socket, "subscribe", { sessionId: session.id })
      ).toEqual(SUBSCRIBED);
      const received = record(socket, [
        "space.member_removed",
        "space.access_revoked",
      ]);

      const removed = await fetchJson(
        "DELETE",
        `${app.url}/v1/spaces/${space.id}/members/${alice.principal.id}`,
        owner.token
      );
      expect(removed.status, JSON.stringify(removed.body)).toBe(204);

      await eventually(() => received.length === 2);
      expect(received).toEqual([
        ["space.member_removed", alice.principal.id],
        ["space.access_revoked", alice.principal.id],
      ]);
      const rooms = serverSocket(socket, node).rooms;
      expect(rooms.has(spaceRoom(space.id))).toBe(false);
      expect(rooms.has(sessionRoom(session.id))).toBe(false);
      const silent = noEvent(socket, "message.created", 500);
      await send(session.id, owner, "after the removal");
      await silent;
    }
  );

  it("sends no session.access_revoked to a removed participant who still reads through a kind grant, and drops their room", async () => {
    const permission = `fanout-test.cases.read`;
    const kind = await api.kind(`fanout-test:${uuidv7().slice(-8)}`, {
      grants: [{ permission, access: "read" }],
    });
    const space = await fixtures.space({ org, kind, visibility: "members" });
    const session = await fixtures.session({ space, access: "members" });
    await fixtures.member(space, owner.principal, "owner");
    await fixtures.participant(session, owner.principal, "owner");
    const granted = await api.actor(org, [permission]);
    const plain = await api.actor(org);
    await fixtures.participant(session, granted.principal);
    await fixtures.participant(session, plain.principal);
    const grantedSocket = await connect(granted);
    const plainSocket = await connect(plain);
    const toGranted = record(grantedSocket, [
      "session.participant_removed",
      "session.access_revoked",
    ]);
    const toPlain = record(plainSocket, [
      "session.participant_removed",
      "session.access_revoked",
    ]);
    const revokedOnGranted = collect(grantedSocket, "session.access_revoked");

    for (const who of [granted, plain]) {
      const removed = await fetchJson(
        "DELETE",
        `${app.url}/v1/sessions/${session.id}/participants/${who.principal.id}`,
        owner.token
      );
      expect(removed.status, JSON.stringify(removed.body)).toBe(204);
    }

    const own = (received: Array<[string, string]>, who: Actor) =>
      received.filter(([, principalId]) => principalId === who.principal.id);
    await eventually(() => own(toPlain, plain).length === 2);
    expect(own(toPlain, plain)).toEqual([
      ["session.participant_removed", plain.principal.id],
      ["session.access_revoked", plain.principal.id],
    ]);
    expect(toGranted).toContainEqual([
      "session.participant_removed",
      granted.principal.id,
    ]);
    expect(revokedOnGranted).toEqual([]);
    await eventually(
      () =>
        !serverSocket(grantedSocket, local).rooms.has(sessionRoom(session.id))
    );
    expect(
      serverSocket(plainSocket, local).rooms.has(sessionRoom(session.id))
    ).toBe(false);
  });

  it.each([
    ["on the committing node", () => local],
    ["on another node", () => other],
  ])(
    "drops a removed member of a public space from its room %s, though they can still read it",
    async (_where, nodeOf) => {
      const node = nodeOf();
      const space = await fixtures.space({ org, visibility: "public" });
      await fixtures.member(space, owner.principal, "owner");
      const alice = await api.actor(org);
      await fixtures.member(space, alice.principal);
      const socket = await connect(alice, node);
      expect(serverSocket(socket, node).rooms.has(spaceRoom(space.id))).toBe(
        true
      );
      const received = record(socket, [
        "space.member_removed",
        "space.access_revoked",
      ]);

      const removed = await fetchJson(
        "DELETE",
        `${app.url}/v1/spaces/${space.id}/members/${alice.principal.id}`,
        owner.token
      );
      expect(removed.status, JSON.stringify(removed.body)).toBe(204);

      await eventually(
        () => !serverSocket(socket, node).rooms.has(spaceRoom(space.id))
      );
      expect(received).toEqual([["space.member_removed", alice.principal.id]]);
      const silent = noEvent(socket, "space.updated", 500);
      const patched = await fetchJson(
        "PATCH",
        `${app.url}/v1/spaces/${space.id}`,
        owner.token,
        { name: "renamed after the removal" }
      );
      expect(patched.status, JSON.stringify(patched.body)).toBe(200);
      await silent;
    }
  );

  it("drops a removed participant of a public space's session from its room and spaceof:, though they can still read it", async () => {
    const space = await fixtures.space({ org, visibility: "public" });
    const session = await fixtures.session({ space, access: "space" });
    await fixtures.member(space, owner.principal, "owner");
    await fixtures.participant(session, owner.principal, "owner");
    const alice = await api.actor(org);
    await fixtures.participant(session, alice.principal);
    const socket = await connect(alice);
    const rooms = () => serverSocket(socket, local).rooms;
    expect(rooms().has(sessionRoom(session.id))).toBe(true);
    expect(rooms().has(spaceOfRoom(space.id))).toBe(true);

    const removed = await fetchJson(
      "DELETE",
      `${app.url}/v1/sessions/${session.id}/participants/${alice.principal.id}`,
      owner.token
    );
    expect(removed.status, JSON.stringify(removed.body)).toBe(204);

    await eventually(() => !rooms().has(sessionRoom(session.id)));
    await eventually(() => !rooms().has(spaceOfRoom(space.id)));
    const silent = noEvent(socket, "message.created", 500);
    await send(session.id, owner, "after the removal");
    await silent;
  });
});
