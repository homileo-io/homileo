import { prisma } from "../../utils/db/prisma.js";
import { fetchJson } from "./http.js";
import { v7 as uuidv7 } from "uuid";
import env from "../../env.js";

export const messagesUrl = (sessionId: string, base: string = env.PUBLIC_URL) =>
  `${base}/v1/sessions/${sessionId}/messages`;

/** `POST …/messages` with a fresh `clientMessageId` unless `body` names one. */
export const sendMessage = (
  sessionId: string,
  token: string,
  body: Record<string, unknown>,
  base?: string
) =>
  fetchJson("POST", messagesUrl(sessionId, base), token, {
    clientMessageId: uuidv7(),
    ...body,
  });

export const listMessages = (sessionId: string, token: string, query = "") =>
  fetchJson("GET", `${messagesUrl(sessionId)}${query}`, token);

/** The `core.core_outbox` notification rows addressed to a tereo user. */
export const notificationsTo = (tereoUserId: string) =>
  prisma.$queryRaw<Array<{ payload: Record<string, unknown> }>>`
    SELECT payload FROM "core"."core_outbox"
    WHERE destination = 'notification'
      AND payload->'recipients' @> ${JSON.stringify([{ userId: tereoUserId }])}::jsonb`;

export const messageUrl = (messageId: string, base: string = env.PUBLIC_URL) =>
  `${base}/v1/messages/${messageId}`;

export const getMessage = (messageId: string, token: string) =>
  fetchJson("GET", messageUrl(messageId), token);

export const editMessage = (
  messageId: string,
  token: string,
  body: Record<string, unknown>,
  base?: string
) => fetchJson("PATCH", messageUrl(messageId, base), token, body);

export const deleteMessage = (
  messageId: string,
  token: string,
  base?: string
) => fetchJson("DELETE", messageUrl(messageId, base), token);

export const listRevisions = (messageId: string, token: string) =>
  fetchJson("GET", `${messageUrl(messageId)}/revisions`, token);
