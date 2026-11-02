// @module-tag int
// @module-tag websocket
// @module-tag auth
import { botToken, personToken } from "../support/tokens.js";
import { revalidateSockets } from "../../websocket/auth.js";
import { connectCheckOf } from "../../websocket/index.js";
import { UnauthorizedError } from "../../utils/errors.js";
import * as rooms from "../../websocket/rooms.js";
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
// Passes through; counted to tell whether a re-check judged the rooms again.
vi.mock("../../websocket/rooms.js", async (importOriginal) => {
  const original = await importOriginal<typeof rooms>();
  return { ...original, recheckSockets: vi.fn(original.recheckSockets) };
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

  it.each([[[]], [["homileo.messages.read_private"]]])(
    "refuses a token with %j, without homileo.spaces.read, as forbidden",
    async (perms: string[]) => {
      expect(await refusal(personToken({ org: uuidv7(), perms }))).toBe(
        "forbidden"
      );
    }
  );

  it.each([["homileo.spaces.read"], ["homileo.chat.admin"]])(
    "connects a token with only %s",
    async (permission) => {
      const socket = await open(
        personToken({ org: uuidv7(), perms: [permission] })
      );

      expect(socket.connected).toBe(true);
    }
  );

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

  describe("re-introspection", () => {
    const serverSocket = (socket: ClientSocket) => {
      const found = local.io.of("/").sockets.get(socket.id!);
      if (!found) throw new Error("no server socket");
      return found;
    };

    it("disconnects a socket whose token tereo no longer accepts, even with no exp", async () => {
      const real = vi.mocked(auth.callerFromToken);
      real.mockImplementationOnce(async (token) => {
        const result = await vi
          .importActual<typeof auth>("../../middleware/auth.js")
          .then((m) => m.callerFromToken(token));
        return { ...result, exp: null };
      });
      const socket = await open(personToken({ org: uuidv7() }), local.url);
      real.mockRejectedValueOnce(
        new UnauthorizedError("Invalid or expired token")
      );

      await revalidateSockets([serverSocket(socket)]);

      expect(await disconnected(socket)).toBe("io server disconnect");
    });

    it("takes the token's current permissions while it is still active", async () => {
      const socket = await open(
        personToken({ org: uuidv7(), perms: ["homileo.spaces.read"] }),
        local.url
      );
      const onServer = serverSocket(socket);
      const real = vi.mocked(auth.callerFromToken);
      real.mockImplementationOnce(async (token) => {
        const result = await vi
          .importActual<typeof auth>("../../middleware/auth.js")
          .then((m) => m.callerFromToken(token));
        return {
          ...result,
          caller: {
            ...result.caller,
            permissions: ["homileo.chat.admin"],
            isAdmin: true,
          },
        };
      });

      await revalidateSockets([onServer]);

      expect(onServer.data.caller.permissions).toEqual(["homileo.chat.admin"]);
      expect(socket.connected).toBe(true);
    });

    it("disconnects a socket whose token no longer holds homileo.spaces.read", async () => {
      const socket = await open(
        personToken({ org: uuidv7(), perms: ["homileo.spaces.read"] }),
        local.url
      );
      const real = vi.mocked(auth.callerFromToken);
      real.mockImplementationOnce(async (token) => {
        const result = await vi
          .importActual<typeof auth>("../../middleware/auth.js")
          .then((m) => m.callerFromToken(token));
        return { ...result, caller: { ...result.caller, permissions: [] } };
      });

      await revalidateSockets([serverSocket(socket)]);

      expect(await disconnected(socket)).toBe("io server disconnect");
    });

    it("does not re-check the rooms when only the permissions' order changed", async () => {
      const perms = ["homileo.spaces.write", "homileo.messages.read_private"];
      const socket = await open(
        personToken({ org: uuidv7(), perms }),
        local.url
      );
      const real = vi.mocked(auth.callerFromToken);
      real.mockImplementationOnce(async (token) => {
        const result = await vi
          .importActual<typeof auth>("../../middleware/auth.js")
          .then((m) => m.callerFromToken(token));
        return {
          ...result,
          caller: { ...result.caller, permissions: [...perms].reverse() },
        };
      });
      const onServer = serverSocket(socket);
      // Connecting re-checks the rooms once of its own.
      await connectCheckOf(onServer);
      const recheck = vi.mocked(rooms.recheckSockets);
      recheck.mockClear();

      await revalidateSockets([onServer]);

      expect(recheck).not.toHaveBeenCalled();
      expect(socket.connected).toBe(true);
    });

    it("keeps a socket when the re-check fails for another reason", async () => {
      const socket = await open(personToken({ org: uuidv7() }), local.url);
      vi.mocked(auth.callerFromToken).mockRejectedValueOnce(
        new Error("database down")
      );

      await revalidateSockets([serverSocket(socket)]);

      expect(socket.connected).toBe(true);
    });

    it("introspects a token shared by several sockets once", async () => {
      const token = personToken({ org: uuidv7() });
      const sockets = [
        await open(token, local.url),
        await open(token, local.url),
      ];
      const real = vi.mocked(auth.callerFromToken);
      real.mockClear();

      await revalidateSockets(sockets.map(serverSocket));

      expect(real).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps a socket whose token is still valid", async () => {
    const socket = await open(personToken({ org: uuidv7() }), local.url);

    await new Promise((r) => setTimeout(r, 1500));

    expect(socket.connected).toBe(true);
  });
});
