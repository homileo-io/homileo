import { claimSocketSlot, limitEvents, MAX_PACKET_BYTES } from "./limits.js";
import { handleEphemeral, startPresenceSweep } from "./ephemeral.js";
import { authenticateSocket, closeAtExpiry } from "./auth.js";
import { redisRetryStrategy } from "../utils/redisRetry.js";
import { closeRedisClient, redis } from "../utils/redis.js";
import { recheckSockets, roomsOnConnect } from "./rooms.js";
import { createAdapter } from "@socket.io/redis-adapter";
import { handleSubscriptions } from "./subscriptions.js";
import type { AppSocket, IOServer } from "./types.js";
import { startFanout, stopFanout } from "./fanout.js";
import type { Server as HttpServer } from "http";
import { logger } from "../utils/logger.js";
import type { Redis } from "ioredis";
import { Server } from "socket.io";
import env from "../env.js";

export type {
  AppSocket,
  AppRemoteSocket,
  IOServer,
  SocketData,
} from "./types.js";
export { recheckSockets } from "./rooms.js";

/** Commands whose promise the Redis adapter (and ioredis's own resubscribe) drops. */
const DROPPED_COMMANDS = [
  "publish",
  "subscribe",
  "psubscribe",
  "unsubscribe",
  "punsubscribe",
] as const;

type DroppedCommand = (typeof DROPPED_COMMANDS)[number];
type Command = (...args: unknown[]) => Promise<unknown>;

/**
 * A rejection nobody handles ends the process in production (index.ts), so one Redis blip
 * during a broadcast would take the node down. Failures are logged here instead; a lost
 * cross-node emit is no worse than one sent while the other nodes were unreachable.
 */
const catchDroppedCommands = (client: Redis, role: "pub" | "sub") => {
  const commands = client as unknown as Record<DroppedCommand, Command>;
  for (const command of DROPPED_COMMANDS) {
    const original = commands[command].bind(client);
    commands[command] = (...args) =>
      original(...args).catch((err: unknown) => {
        logger.warn({ err, command }, `Socket Redis ${role} command failed`);
        return undefined;
      });
  }
};

/**
 * The pub client fails a command after a few retries, so emits during an outage are dropped
 * rather than queued without bound. The sub client waits: a subscribe that failed would never
 * be retried, and the node would stop hearing other nodes' broadcasts.
 */
const createRedisClient = (role: "pub" | "sub"): Redis => {
  const client = redis.duplicate({
    lazyConnect: false,
    maxRetriesPerRequest: role === "pub" ? 3 : null,
    retryStrategy: redisRetryStrategy,
  });
  client.on("error", (err) => {
    logger.error({ err }, `Socket Redis ${role} client error`);
  });
  catchDroppedCommands(client, role);
  return client;
};

// Pub/sub channels ignore the selected database, so deployments or test runs sharing one
// Redis server would hear each other's broadcasts without it in the key.
const adapterKey = () =>
  `${env.SERVICE_NAME}:${redis.options.db ?? 0}:socket.io`;

const connectChecks = new WeakMap<AppSocket, Promise<void>>();

/** Settles once the re-check a socket gets right after joining its rooms has run. */
export const connectCheckOf = (socket: AppSocket): Promise<void> =>
  connectChecks.get(socket) ?? Promise.resolve();

interface Instance {
  pub: Redis;
  sub: Redis;
  draining: boolean;
}

const instances = new WeakMap<IOServer, Instance>();

/** A socket.io server on `/ws` of `http`, over the Redis adapter. */
export const createSocketServer = async (
  http: HttpServer
): Promise<IOServer> => {
  const pub = createRedisClient("pub");
  const sub = createRedisClient("sub");
  const instance: Instance = { pub, sub, draining: false };
  const io: IOServer = new Server(http, {
    path: "/ws",
    // The token comes in `auth`, not a cookie: no credentialed CORS.
    cors: { origin: env.CORS_ORIGINS },
    transports: ["websocket", "polling"],
    maxHttpBufferSize: MAX_PACKET_BYTES,
  });
  io.adapter(createAdapter(pub, sub, { key: adapterKey() }));
  instances.set(io, instance);

  // Before authenticating, so a draining node does no database work.
  io.use((_socket, next) => {
    if (instance.draining) next(new Error("shutting_down"));
    else next();
  });
  io.use((socket, next) => void authenticateSocket(socket, next));
  // Loaded in the handshake and joined at once on connect, so the client's first event
  // already finds the socket in its rooms.
  const initialRooms = new WeakMap<AppSocket, string[]>();
  io.use((socket, next) => {
    roomsOnConnect(socket.data.caller).then(
      (rooms) => {
        initialRooms.set(socket, rooms);
        next();
      },
      (err: unknown) => {
        logger.error(
          { err, principalId: socket.data.caller.principalId },
          "Loading a socket's rooms failed"
        );
        next(new Error("internal_error"));
      }
    );
  });
  // Last, so a refused handshake holds no slot.
  io.use(claimSocketSlot);

  io.on("connection", (socket: AppSocket) => {
    void socket.join(initialRooms.get(socket) ?? []);
    initialRooms.delete(socket);
    // A revocation between the handshake's load and the joins above re-checked the
    // principal's sockets before this one was in those rooms: check once more.
    connectChecks.set(
      socket,
      recheckSockets([socket]).then(
        () => undefined,
        (err: unknown) => {
          logger.error(
            { err, principalId: socket.data.caller.principalId },
            "Re-checking a new socket's rooms failed"
          );
        }
      )
    );
    closeAtExpiry(socket);
    limitEvents(socket);
    handleSubscriptions(socket);
    handleEphemeral(socket);
  });

  return io;
};

/** Refuses new handshakes and closes this node's sockets; the Redis clients stay up. */
export const disconnectSocketServer = async (io: IOServer): Promise<void> => {
  const instance = instances.get(io);
  if (instance) instance.draining = true;
  // `local`: through the Redis adapter, a plain disconnect reaches every node's sockets.
  io.local.disconnectSockets(true);
  io.engine?.close();
};

/** Closes the sockets, then the adapter's Redis clients. */
export const closeSocketServer = async (io: IOServer): Promise<void> => {
  await disconnectSocketServer(io);
  const instance = instances.get(io);
  if (!instance) return;
  instances.delete(io);
  await Promise.all([instance.pub, instance.sub].map(closeRedisClient));
};

let io: IOServer | null = null;
let stopPresenceSweep: (() => void) | null = null;

/** Attaches the node's socket server to `http`; call before `listen`. */
export const attachSockets = async (http: HttpServer): Promise<void> => {
  if (io) throw new Error("Sockets are already attached");
  io = await createSocketServer(http);
  stopPresenceSweep = startPresenceSweep(io);
  startFanout(io);
  logger.info("Socket server attached on /ws");
};

/** Closes this node's sockets, keeping the Redis clients for requests still draining. */
export const disconnectSockets = async (): Promise<void> => {
  if (io) await disconnectSocketServer(io);
};

export const closeSockets = async (): Promise<void> => {
  if (!io) return;
  const closing = io;
  io = null;
  stopPresenceSweep?.();
  stopPresenceSweep = null;
  await stopFanout(closing);
  await closeSocketServer(closing);
};

/** The node's socket server; throws before `attachSockets`. */
export const getIO = (): IOServer => {
  if (!io) throw new Error("Sockets are not attached");
  return io;
};
