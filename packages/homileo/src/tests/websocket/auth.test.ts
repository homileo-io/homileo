// @module-tag int
// @module-tag websocket
// @module-tag auth
import { botToken, personToken } from "../support/tokens.js";
import * as auth from "../../middleware/auth.js";
import { v7 as uuidv7 } from "uuid";
import {
  disconnected,
  openSocket,
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

// Passes through unless a test overrides it, so one test can shorten a token's life.
vi.mock("../../middleware/auth.js", async (importOriginal) => {
  const original = await importOriginal<typeof auth>();
  return { ...original, callerFromToken: vi.fn(original.callerFromToken) };
});

const opened: ClientSocket[] = [];
const open = async (token: string | null, url?: string) => {
  const socket = await openSocket(token, url);
  opened.push(socket);
  return socket;
};
const refusal = (token: string | null, url?: string) =>
  open(token, url).then(
    () => {
      throw new Error("expected the handshake to be refused");
    },
    (err: Error) => err.message
  );

afterEach(() => {
  for (const socket of opened.splice(0)) socket.close();
});

describe("socket handshake", () => {
  it("connects with a valid token that has an organization", async () => {
    const socket = await open(personToken({ org: uuidv7() }));

    expect(socket.connected).toBe(true);
  });

  it("connects a bot with an organization", async () => {
    const socket = await open(botToken({ org: uuidv7() }));

    expect(socket.connected).toBe(true);
  });

  it("refuses a handshake without a token as unauthorized", async () => {
    expect(await refusal(null)).toBe("unauthorized");
  });

  it("refuses an invalid token as unauthorized", async () => {
    expect(await refusal("not-a-token")).toBe("unauthorized");
  });

  it("refuses a token without an organization as organization_required", async () => {
    expect(await refusal(personToken({ org: null }))).toBe(
      "organization_required"
    );
  });

  it("refuses the 21st socket of one principal", async () => {
    const token = personToken({ org: uuidv7() });
    for (let i = 0; i < 20; i++) await open(token);

    expect(await refusal(token)).toBe("too_many_connections");
  });

  it("frees a principal's slot when its socket disconnects", async () => {
    const token = personToken({ org: uuidv7() });
    const sockets: ClientSocket[] = [];
    for (let i = 0; i < 20; i++) sockets.push(await open(token));
    sockets[0].close();

    await expect
      .poll(async () => {
        try {
          await open(token);
          return true;
        } catch {
          return false;
        }
      })
      .toBe(true);
  });
});

describe("socket token expiry", () => {
  let local: LocalSocketServer;

  beforeAll(async () => {
    local = await startSocketServer();
  });

  afterAll(() => local.close());

  it("disconnects a socket when its token's exp passes", async () => {
    const real = vi.mocked(auth.callerFromToken);
    real.mockImplementationOnce(async (token) => {
      const result = await vi
        .importActual<typeof auth>("../../middleware/auth.js")
        .then((m) => m.callerFromToken(token));
      // At least a whole second away, so the socket connects before it expires.
      return { ...result, exp: Math.ceil(Date.now() / 1000) + 1 };
    });
    const socket = await open(personToken({ org: uuidv7() }), local.url);

    expect(await disconnected(socket, 4000)).toBe("io server disconnect");
  });

  it("keeps a socket whose token is still valid", async () => {
    const socket = await open(personToken({ org: uuidv7() }), local.url);

    await new Promise((r) => setTimeout(r, 1500));

    expect(socket.connected).toBe(true);
  });
});
