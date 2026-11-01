// @module-tag int
// @module-tag websocket
// @module-tag events
import { publishCommitted } from "../../utils/changeBus.js";
import type { ChangeEvent } from "../../utils/changes.js";
import { chatFixtures } from "../support/chatFixtures.js";
import type { JsonResponse } from "../support/http.js";
import { personToken } from "../support/tokens.js";
import { v7 as uuidv7 } from "uuid";
import {
  nextEvent,
  openLocalSocket,
  startSocketServer,
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
