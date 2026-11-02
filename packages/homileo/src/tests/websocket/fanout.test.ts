// @module-tag int
// @module-tag websocket
// @module-tag events
import { deleteMessage, sendMessage } from "../support/messageApi.js";
import { sessionRoom, spaceOfRoom } from "../../realtime/rooms.js";
import { drainSync, syncHead, syncTail } from "../support/sync.js";
import { fetchJson, type JsonResponse } from "../support/http.js";
import { spaceApiFixtures } from "../support/spaceApi.js";
import { startV1App } from "../support/v1App.js";
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
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const api = spaceApiFixtures();
const { fixtures } = api;
type Actor = Awaited<ReturnType<typeof api.actor>>;
let org = "";
let owner: Actor;
// The routes commit in this process, so the local socket server is the node that fans out.
let app: Awaited<ReturnType<typeof startV1App>>;
let local: LocalSocketServer;
const opened: ClientSocket[] = [];

const connect = async (who: Actor) => {
  const socket = await openLocalSocket(who.token, local);
  opened.push(socket);
  return socket;
};

const serverSocket = (socket: ClientSocket) => {
  const found = local.io.of("/").sockets.get(socket.id!);
  if (!found) throw new Error("no server socket");
  return found;
};

const send = async (sessionId: string, who: Actor, body: string) => {
  const res = await sendMessage(sessionId, who.token, { body }, app.url);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.message as { id: string };
};

beforeAll(async () => {
  app = await startV1App();
  local = await startSocketServer({ fanout: true });
  org = api.organization();
  owner = await api.actor(org);
});

afterEach(() => {
  for (const socket of opened.splice(0)) socket.close();
});

afterAll(async () => {
  await local.close();
  await app.close();
  await api.cleanup();
});

describe("startFanout", () => {
  describe("delivery", () => {
    it("sends a participant's socket message.created with the envelope and id /sync returns", async () => {
      const alice = await api.actor(org);
      const session = await fixtures.session({ org, type: "group" });
      await fixtures.participant(session, owner.principal, "owner");
      await fixtures.participant(session, alice.principal);
      const since = await syncHead(alice.token, app.url);
      const socket = await connect(alice);
      const arriving = nextEvent<JsonResponse["body"]>(
        socket,
        "message.created"
      );

      const sent = await send(session.id, owner, "hello");
      const received = await arriving;

      const { events } = await drainSync(alice.token, since, {}, app.url);
      const synced = events.find((e) => e.type === "message.created");
      expect(received.payload.message.id).toBe(sent.id);
      expect(received).toEqual(synced);
      expect(received.id).toMatch(/^\d+$/);
    });

    it("reaches a subscribed non-participant of a public space's session, and not one who is not subscribed", async () => {
      const space = await fixtures.space({ org, visibility: "public" });
      const session = await fixtures.session({ space, access: "space" });
      await fixtures.member(space, owner.principal, "owner");
      await fixtures.participant(session, owner.principal, "owner");
      const watcher = await api.actor(org);
      const bystander = await api.actor(org);
      const watching = await connect(watcher);
      const notWatching = await connect(bystander);
      expect(
        await request(watching, "subscribe", { sessionId: session.id })
      ).toEqual(SUBSCRIBED);
      const arriving = nextEvent<JsonResponse["body"]>(
        watching,
        "message.created"
      );
      const silent = noEvent(notWatching, "message.created", 500);

      const sent = await send(session.id, owner, "to the public");

      expect((await arriving).payload.message.id).toBe(sent.id);
      await silent;
    });

    it("sends a mentioned member who is not a participant the message once, even when subscribed too", async () => {
      const space = await fixtures.space({ org, visibility: "members" });
      const session = await fixtures.session({ space, access: "space" });
      await fixtures.member(space, owner.principal, "owner");
      await fixtures.participant(session, owner.principal, "owner");
      const mentioned = await api.actor(org);
      const subscribed = await api.actor(org);
      await fixtures.member(space, mentioned.principal);
      await fixtures.member(space, subscribed.principal);
      const plain = await connect(mentioned);
      const both = await connect(subscribed);
      expect(
        await request(both, "subscribe", { sessionId: session.id })
      ).toEqual(SUBSCRIBED);
      const toPlain = collect<JsonResponse["body"]>(plain, "message.created");
      const toBoth = collect<JsonResponse["body"]>(both, "message.created");

      const sent = await send(
        session.id,
        owner,
        `hi <@${mentioned.principal.id}> and <@${subscribed.principal.id}>`
      );
      await eventually(() => toPlain.length > 0 && toBoth.length > 0);
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(toPlain.map((e) => e.payload.message.id)).toEqual([sent.id]);
      expect(toBoth.map((e) => e.payload.message.id)).toEqual([sent.id]);
    });

    it("sends message.deleted to a mentioned member who is not a participant, as /sync does", async () => {
      const space = await fixtures.space({ org, visibility: "members" });
      const session = await fixtures.session({ space, access: "space" });
      await fixtures.member(space, owner.principal, "owner");
      await fixtures.participant(session, owner.principal, "owner");
      const mentioned = await api.actor(org);
      await fixtures.member(space, mentioned.principal);
      const since = await syncHead(mentioned.token, app.url);
      const socket = await connect(mentioned);
      const created = nextEvent<JsonResponse["body"]>(
        socket,
        "message.created"
      );
      const deleted = nextEvent<JsonResponse["body"]>(
        socket,
        "message.deleted"
      );

      const sent = await send(
        session.id,
        owner,
        `<@${mentioned.principal.id}> secret`
      );
      await created;
      const res = await deleteMessage(sent.id, owner.token, app.url);
      expect(res.status, JSON.stringify(res.body)).toBe(200);

      const received = await deleted;
      expect(received.payload.message).toMatchObject({
        id: sent.id,
        body: null,
      });
      const { events } = await drainSync(
        mentioned.token,
        since,
        { until: await syncTail() },
        app.url
      );
      expect(events.map((e) => e.type)).toEqual([
        "message.created",
        "message.deleted",
      ]);
    });

    it("asks no other node for the sockets of mentioned participants: their session room reaches them", async () => {
      const session = await fixtures.session({ org, type: "group" });
      await fixtures.participant(session, owner.principal, "owner");
      const mentioned = await api.actor(org);
      await fixtures.participant(session, mentioned.principal);
      const arriving = nextEvent<JsonResponse["body"]>(
        await connect(mentioned),
        "message.created"
      );
      const adapter = local.io.of("/").adapter;
      const fetches = vi.spyOn(adapter, "fetchSockets");

      const sent = await send(
        session.id,
        owner,
        `hi <@${mentioned.principal.id}>`
      );

      expect((await arriving).payload.message.id).toBe(sent.id);
      expect(fetches.mock.calls.filter(([o]) => !o.flags?.local)).toEqual([]);
      fetches.mockRestore();
    });

    it("does not send a mention to a principal who cannot read the session", async () => {
      const space = await fixtures.space({ org, visibility: "members" });
      const session = await fixtures.session({ space, access: "space" });
      await fixtures.member(space, owner.principal, "owner");
      await fixtures.participant(session, owner.principal, "owner");
      const outsider = await api.actor(org);
      const socket = await connect(outsider);
      const silent = noEvent(socket, "message.created", 500);

      await send(session.id, owner, `hi <@${outsider.principal.id}>`);

      await silent;
    });
  });

  describe("created", () => {
    it("sends session.created of a direct session to both participants' sockets, as /sync does", async () => {
      const alice = await api.actor(org);
      const bob = await api.actor(org);
      const since = await syncHead(bob.token, app.url);
      const toAlice = nextEvent<JsonResponse["body"]>(
        await connect(alice),
        "session.created"
      );
      const toBob = nextEvent<JsonResponse["body"]>(
        await connect(bob),
        "session.created"
      );

      const res = await fetchJson(
        "POST",
        `${app.url}/v1/sessions/direct`,
        alice.token,
        { principalId: bob.principal.id }
      );
      expect(res.status, JSON.stringify(res.body)).toBe(201);

      const sessionId = res.body.session.id;
      expect((await toAlice).payload.session.id).toBe(sessionId);
      const received = await toBob;
      expect(received.payload.session.id).toBe(sessionId);
      const { events } = await drainSync(bob.token, since, {}, app.url);
      expect(events.find((e) => e.type === "session.created")).toEqual(
        received
      );
    });

    it("sends space.created to its owner's sockets, as /sync does", async () => {
      const alice = await api.actor(org, ["homileo.spaces.write"]);
      const since = await syncHead(alice.token, app.url);
      const arriving = nextEvent<JsonResponse["body"]>(
        await connect(alice),
        "space.created"
      );

      const res = await fetchJson("POST", `${app.url}/v1/spaces`, alice.token, {
        name: "a new space",
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);

      const received = await arriving;
      expect(received.payload.space.id).toBe(res.body.space.id);
      const { events } = await drainSync(alice.token, since, {}, app.url);
      expect(events.find((e) => e.type === "space.created")).toEqual(received);
    });
  });

  describe("joins", () => {
    it("puts a new participant's socket in the session room before participant_added arrives, and later messages reach it", async () => {
      const space = await fixtures.space({ org, visibility: "public" });
      const session = await fixtures.session({ space, access: "space" });
      await fixtures.member(space, owner.principal, "owner");
      await fixtures.participant(session, owner.principal, "owner");
      const alice = await api.actor(org);
      await fixtures.member(space, alice.principal);
      const socket = await connect(alice);
      // Subscribed first: the participation join takes the room over from the subscription.
      expect(
        await request(socket, "subscribe", { sessionId: session.id })
      ).toEqual(SUBSCRIBED);
      let roomsOnArrival: string[] = [];
      socket.once("session.participant_added", () => {
        roomsOnArrival = [...serverSocket(socket).rooms];
      });
      const added = nextEvent<JsonResponse["body"]>(
        socket,
        "session.participant_added"
      );

      const put = await fetchJson(
        "PUT",
        `${app.url}/v1/sessions/${session.id}/participants/${alice.principal.id}`,
        owner.token
      );
      expect(put.status, JSON.stringify(put.body)).toBe(201);

      expect((await added).payload.participant.principalId).toBe(
        alice.principal.id
      );
      expect(roomsOnArrival).toEqual(
        expect.arrayContaining([sessionRoom(session.id), spaceOfRoom(space.id)])
      );
      expect(
        serverSocket(socket).data.subscriptions.has(sessionRoom(session.id))
      ).toBe(false);

      // A participant's room is not the subscription's to leave.
      expect(
        await request(socket, "unsubscribe", { sessionId: session.id })
      ).toEqual({ ok: true });
      const arriving = nextEvent<JsonResponse["body"]>(
        socket,
        "message.created"
      );
      const sent = await send(session.id, owner, "welcome");
      expect((await arriving).payload.message.id).toBe(sent.id);
    });
  });

  describe("visibility", () => {
    it("sends space.updated only to the sockets that can still read the space", async () => {
      const space = await fixtures.space({ org, visibility: "public" });
      await fixtures.member(space, owner.principal, "owner");
      const outsider = await api.actor(org);
      const member = await api.actor(org);
      await fixtures.member(space, member.principal);
      const outside = await connect(outsider);
      const inside = await connect(member);
      expect(
        await request(outside, "subscribe", { spaceId: space.id })
      ).toEqual(SUBSCRIBED);
      const silent = noEvent(outside, "space.updated", 500);
      const arriving = nextEvent(inside, "space.updated");

      const patched = await fetchJson(
        "PATCH",
        `${app.url}/v1/spaces/${space.id}`,
        owner.token,
        { visibility: "members" }
      );
      expect(patched.status, JSON.stringify(patched.body)).toBe(200);

      await arriving;
      await silent;
    });

    it.each([
      ["a members-only space", "members"],
      ["a public space", "public"],
    ] as const)(
      "does not re-check any socket when %s is renamed",
      async (_name, visibility) => {
        const space = await fixtures.space({ org, visibility });
        await fixtures.member(space, owner.principal, "owner");
        const member = await api.actor(org);
        await fixtures.member(space, member.principal);
        const socket = await connect(member);
        const fetching = vi.spyOn(local.io.of("/").adapter, "fetchSockets");
        try {
          const arriving = nextEvent(socket, "space.updated");

          const patched = await fetchJson(
            "PATCH",
            `${app.url}/v1/spaces/${space.id}`,
            owner.token,
            { name: `renamed ${visibility}` }
          );
          expect(patched.status, JSON.stringify(patched.body)).toBe(200);

          await arriving;
          expect(fetching).not.toHaveBeenCalled();
        } finally {
          fetching.mockRestore();
        }
      }
    );

    it("drops non-members' subscribed sockets from a space's session rooms when it turns members-only", async () => {
      const space = await fixtures.space({ org, visibility: "public" });
      const session = await fixtures.session({ space, access: "space" });
      await fixtures.member(space, owner.principal, "owner");
      await fixtures.participant(session, owner.principal, "owner");
      const outsider = await api.actor(org);
      const member = await api.actor(org);
      await fixtures.member(space, member.principal);
      const outside = await connect(outsider);
      const inside = await connect(member);
      for (const socket of [outside, inside]) {
        expect(
          await request(socket, "subscribe", { sessionId: session.id })
        ).toEqual(SUBSCRIBED);
      }

      const patched = await fetchJson(
        "PATCH",
        `${app.url}/v1/spaces/${space.id}`,
        owner.token,
        { visibility: "members" }
      );
      expect(patched.status, JSON.stringify(patched.body)).toBe(200);

      await eventually(
        () => !serverSocket(outside).rooms.has(sessionRoom(session.id))
      );
      expect(serverSocket(outside).rooms.has(spaceOfRoom(space.id))).toBe(
        false
      );
      expect(serverSocket(inside).rooms.has(sessionRoom(session.id))).toBe(
        true
      );
      const silent = noEvent(outside, "message.created", 500);
      const arriving = nextEvent(inside, "message.created");
      await send(session.id, owner, "members only now");
      await arriving;
      await silent;
    });
  });
});
