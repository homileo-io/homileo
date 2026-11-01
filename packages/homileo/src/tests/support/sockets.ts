import { io as connect, type Socket as ClientSocket } from "socket.io-client";
import { startFanout, stopFanout } from "../../websocket/fanout.js";
import { initializeTereo } from "../../utils/tereo.js";
import { createServer } from "http";
import { expect } from "vitest";
import env from "../../env.js";
import {
  closeSocketServer,
  connectCheckOf,
  createSocketServer,
  type IOServer,
} from "../../websocket/index.js";

export type { ClientSocket };

/**
 * A socket connected to the shared test server (or `url`) with `token`. Rejects with the
 * handshake's error, whose `message` is the refusal's code.
 */
export const openSocket = (
  token: string | null,
  url: string = env.PUBLIC_URL
): Promise<ClientSocket> =>
  new Promise((resolve, reject) => {
    const socket = connect(url, {
      path: "/ws",
      transports: ["websocket"],
      reconnection: false,
      forceNew: true,
      auth: token === null ? {} : { token },
    });
    socket.once("connect", () => resolve(socket));
    socket.once("connect_error", (err) => {
      socket.close();
      reject(err);
    });
  });

/**
 * A socket connected to the shared test server (or `url`) with `token`, once the server has
 * sent `ready`; `until` is the position its catch-up must reach.
 */
export const openReadySocket = (
  token: string,
  url: string = env.PUBLIC_URL,
  timeoutMs = 5000
): Promise<{ socket: ClientSocket; until: string }> =>
  new Promise((resolve, reject) => {
    const socket = connect(url, {
      path: "/ws",
      transports: ["websocket"],
      reconnection: false,
      forceNew: true,
      auth: { token },
    });
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`no ready within ${timeoutMs} ms`));
    }, timeoutMs);
    socket.once("ready", (payload: { until: string }) => {
      clearTimeout(timer);
      resolve({ socket, until: payload.until });
    });
    socket.once("connect_error", (err) => {
      clearTimeout(timer);
      socket.close();
      reject(err);
    });
  });

/** The next `type` event's first argument; rejects after `timeoutMs`. */
export const nextEvent = <T = unknown>(
  socket: ClientSocket,
  type: string,
  timeoutMs = 2000
): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(type, onEvent);
      reject(new Error(`no ${type} within ${timeoutMs} ms`));
    }, timeoutMs);
    const onEvent = (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    };
    socket.once(type, onEvent);
  });

/** Resolves if no `type` event arrives within `ms`; rejects with the event otherwise. */
export const noEvent = (
  socket: ClientSocket,
  type: string,
  ms = 300
): Promise<void> =>
  new Promise((resolve, reject) => {
    const onEvent = (payload: unknown) => {
      clearTimeout(timer);
      reject(new Error(`unexpected ${type}: ${JSON.stringify(payload)}`));
    };
    const timer = setTimeout(() => {
      socket.off(type, onEvent);
      resolve();
    }, ms);
    socket.once(type, onEvent);
  });

/** Emits `type` and resolves with its ack. */
export const request = <T = Ack>(
  socket: ClientSocket,
  type: string,
  payload: unknown,
  timeoutMs = 2000
): Promise<T> => socket.timeout(timeoutMs).emitWithAck(type, payload);

/** A successful `subscribe` ack, which carries the position its catch-up must reach. */
export const SUBSCRIBED = { ok: true, until: expect.any(String) };

export type Ack =
  | ({ ok: true } & Record<string, unknown>)
  | { ok: false; error: { code: string; message: string } };

/** Resolves once the server has closed `socket`. */
export const disconnected = (
  socket: ClientSocket,
  timeoutMs = 2000
): Promise<string> =>
  socket.disconnected
    ? Promise.resolve("already")
    : nextEvent<string>(socket, "disconnect", timeoutMs);

export interface LocalSocketServer {
  io: IOServer;
  url: string;
  close: () => Promise<void>;
}

/**
 * A socket server in the test's own process, on an ephemeral port, sharing Redis with the
 * shared server. Tests that inspect rooms or server-side sockets connect here: the shared
 * server runs in vitest's main process, out of reach. With `fanout`, it pushes the changes
 * committed in this process (through `startV1App`), as the node that made them.
 */
export const startSocketServer = async (
  o: { fanout?: boolean } = {}
): Promise<LocalSocketServer> => {
  await initializeTereo();
  const http = createServer();
  const io = await createSocketServer(http);
  if (o.fanout) startFanout(io);
  await new Promise<void>((resolve) => http.listen(0, resolve));
  const { port } = http.address() as { port: number };
  return {
    io,
    url: `http://localhost:${port}`,
    close: async () => {
      await stopFanout(io);
      await closeSocketServer(io);
      await new Promise((resolve) => http.close(resolve));
    },
  };
};

/**
 * A socket connected to `server` with `token`, once the re-check it gets after joining its
 * rooms has run: a test that changes access next would otherwise race it.
 */
export const openLocalSocket = async (
  token: string | null,
  server: LocalSocketServer
): Promise<ClientSocket> => {
  const socket = await openSocket(token, server.url);
  const onServer = server.io.of("/").sockets.get(socket.id!);
  if (onServer) await connectCheckOf(onServer);
  return socket;
};

/** The ids of this node's sockets in `room`. */
export const socketsIn = async (
  io: IOServer,
  room: string
): Promise<string[]> =>
  (await io.local.in(room).fetchSockets()).map((s) => s.id).sort();

/** Every `type` event `socket` receives from now on, in arrival order. */
export const collect = <T = unknown>(
  socket: ClientSocket,
  type: string
): T[] => {
  const received: T[] = [];
  socket.on(type, (payload: T) => received.push(payload));
  return received;
};

/** Resolves once `check` holds, polling every 20 ms; rejects after `timeoutMs`. */
export const eventually = async (
  check: () => boolean | Promise<boolean>,
  timeoutMs = 2000
): Promise<void> => {
  const until = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > until) throw new Error(`not within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};
