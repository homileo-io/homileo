import type { DefaultEventsMap, RemoteSocket, Server, Socket } from "socket.io";
import type { Caller } from "../middleware/auth.js";

export interface SocketData {
  caller: Caller;
  /** The rooms joined by `subscribe`, not those joined for membership or participation. */
  subscriptions: Set<string>;
  /** The principals whose presence the socket watches. */
  watched: Set<string>;
  /** The token's expiry, in seconds since the epoch. */
  exp: number | null;
}

export type IOServer = Server<
  DefaultEventsMap,
  DefaultEventsMap,
  DefaultEventsMap,
  SocketData
>;
export type AppSocket = Socket<
  DefaultEventsMap,
  DefaultEventsMap,
  DefaultEventsMap,
  SocketData
>;
export type AppRemoteSocket = RemoteSocket<DefaultEventsMap, SocketData>;

export interface AckError {
  code: string;
  message: string;
  issues?: { path: string; message: string }[];
}

export type Ack =
  ({ ok: true } & Record<string, unknown>) | { ok: false; error: AckError };

export type AckFn = (ack: Ack) => void;
