// @module-tag int
// @module-tag websocket
// @module-tag access
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sessionRoom, spaceOfRoom, spaceRoom } from "../../realtime/rooms.js";
import { editMessage, sendMessage } from "../support/messageApi.js";
import { fetchJson, type JsonResponse } from "../support/http.js";
import { spaceApiFixtures } from "../support/spaceApi.js";
import { drainSync, syncHead } from "../support/sync.js";
import { startV1App } from "../support/v1App.js";
import { v7 as uuidv7 } from "uuid";
import {
  collect,
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
  return res.body.message as { id: string };
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
    const granted = await api.actor(org, [permission, "homileo.spaces.read"]);
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

describe("startFanout mentions", () => {
  it.each([
    ["participant of a members-only session", "members"],
    ["member of the space of a space-access session", "space"],
  ] as const)(
    "stops sending message.edited to a mentioned %s who was removed, as /sync does",
    async (_who, access) => {
      const space = await fixtures.space({ org, visibility: "members" });
      const session = await fixtures.session({ space, access });
      await fixtures.member(space, owner.principal, "owner");
      await fixtures.participant(session, owner.principal, "owner");
      const alice = await api.actor(org);
      await fixtures.member(space, alice.principal);
      if (access === "members") {
        await fixtures.participant(session, alice.principal);
      }
      const sent = await send(session.id, owner, `hi <@${alice.principal.id}>`);
      const removed = await fetchJson(
        "DELETE",
        access === "members"
          ? `${app.url}/v1/sessions/${session.id}/participants/${alice.principal.id}`
          : `${app.url}/v1/spaces/${space.id}/members/${alice.principal.id}`,
        owner.token
      );
      expect(removed.status, JSON.stringify(removed.body)).toBe(204);
      const since = await syncHead(alice.token, app.url);
      const socket = await connect(alice);
      const silent = noEvent(socket, "message.edited", 500);

      const edited = await editMessage(
        sent.id,
        owner.token,
        { metadata: { tag: "after the removal" } },
        app.url
      );
      expect(edited.status, JSON.stringify(edited.body)).toBe(200);

      await silent;
      const { events } = await drainSync(alice.token, since, {}, app.url);
      expect(events.map((e) => e.type)).not.toContain("message.edited");
    }
  );

  it("does not send a mention to a participant who cannot read the members-only space, as /sync does", async () => {
    const space = await fixtures.space({ org, visibility: "members" });
    const session = await fixtures.session({ space, access: "members" });
    await fixtures.member(space, owner.principal, "owner");
    await fixtures.participant(session, owner.principal, "owner");
    const alice = await api.actor(org);
    await fixtures.participant(session, alice.principal);
    const since = await syncHead(alice.token, app.url);
    const socket = await connect(alice);
    const silent = noEvent(socket, "message.created", 500);

    await send(session.id, owner, `hi <@${alice.principal.id}>`);

    await silent;
    const { events } = await drainSync(alice.token, since, {}, app.url);
    expect(events.map((e) => e.type)).not.toContain("message.created");
  });
});

describe("startFanout join requests", () => {
  it("sends join_requested and join_decided to the requester and moderators, not to members or subscribers, as /sync does", async () => {
    const space = await fixtures.space({
      org,
      visibility: "public",
      joinPolicy: "request",
    });
    await fixtures.member(space, owner.principal, "owner");
    const moderator = await api.actor(org);
    const member = await api.actor(org);
    const watcher = await api.actor(org);
    const applicant = await api.actor(org);
    await fixtures.member(space, moderator.principal, "moderator");
    await fixtures.member(space, member.principal);
    const since = await syncHead(member.token, app.url);
    const sockets = {
      moderator: await connect(moderator, other),
      member: await connect(member),
      watcher: await connect(watcher),
      applicant: await connect(applicant, other),
    };
    expect(
      await request(sockets.watcher, "subscribe", { spaceId: space.id })
    ).toEqual(SUBSCRIBED);
    const types = ["space.join_requested", "space.join_decided"];
    const received = Object.fromEntries(
      Object.entries(sockets).map(([who, socket]) => [
        who,
        record(socket, types),
      ])
    );
    const decided = nextEvent(sockets.applicant, "space.join_decided");

    const asked = await fetchJson(
      "POST",
      `${app.url}/v1/spaces/${space.id}/join`,
      applicant.token
    );
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    const denied = await fetchJson(
      "POST",
      `${app.url}/v1/spaces/${space.id}/join-requests/${applicant.principal.id}/deny`,
      moderator.token
    );
    expect(denied.status, JSON.stringify(denied.body)).toBe(200);

    await decided;
    await eventually(() => received.moderator.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 300));
    for (const who of ["moderator", "applicant"]) {
      expect(received[who]).toEqual([
        ["space.join_requested", undefined],
        ["space.join_decided", undefined],
      ]);
    }
    expect(received.member).toEqual([]);
    expect(received.watcher).toEqual([]);
    for (const [reader, query, expected] of [
      [member, {}, false],
      [watcher, { spaceIds: space.id }, false],
      [moderator, {}, true],
    ] as const) {
      const { events } = await drainSync(reader.token, since, query, app.url);
      expect(
        events.some((e) => e.type === "space.join_requested"),
        reader.principal.id
      ).toBe(expected);
    }
  });
});
