import { io as connect, type Socket as ClientSocket } from "socket.io-client";
import { initializeTereo } from "../../utils/tereo.js";
import { createServer } from "http";
import env from "../../env.js";
import {
  closeSocketServer,
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
 * server runs in vitest's main process, out of reach.
 */
export const startSocketServer = async (): Promise<LocalSocketServer> => {
  await initializeTereo();
  const http = createServer();
  const io = await createSocketServer(http);
  await new Promise<void>((resolve) => http.listen(0, resolve));
  const { port } = http.address() as { port: number };
  return {
    io,
    url: `http://localhost:${port}`,
    close: async () => {
      await closeSocketServer(io);
      await new Promise((resolve) => http.close(resolve));
    },
  };
};

/** The ids of this node's sockets in `room`. */
export const socketsIn = async (
  io: IOServer,
  room: string
): Promise<string[]> =>
  (await io.local.in(room).fetchSockets()).map((s) => s.id).sort();
