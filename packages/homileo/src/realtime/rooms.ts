/** The personal room: every socket of a principal in an organization. */
export const userRoom = (organizationId: string, principalId: string) =>
  `user:${organizationId}:${principalId}`;

export const spaceRoom = (spaceId: string) => `space:${spaceId}`;

export const sessionRoom = (sessionId: string) => `session:${sessionId}`;

/** Every socket in a session room of the space. */
export const spaceOfRoom = (spaceId: string) => `spaceof:${spaceId}`;

/** The sockets watching a principal's presence in an organization. */
export const presenceRoom = (organizationId: string, principalId: string) =>
  `presence:${organizationId}:${principalId}`;

const SESSION_PREFIX = "session:";
const SPACE_PREFIX = "space:";

/** The session id of a `session:` room, else `null`. */
export const sessionIdOf = (room: string): string | null =>
  room.startsWith(SESSION_PREFIX) ? room.slice(SESSION_PREFIX.length) : null;

/** The space id of a `space:` room, else `null`. */
export const spaceIdOf = (room: string): string | null =>
  room.startsWith(SPACE_PREFIX) ? room.slice(SPACE_PREFIX.length) : null;

const SPACE_OF_PREFIX = "spaceof:";

/** The space id of a `spaceof:` room, else `null`. */
export const spaceOfIdOf = (room: string): string | null =>
  room.startsWith(SPACE_OF_PREFIX) ? room.slice(SPACE_OF_PREFIX.length) : null;
