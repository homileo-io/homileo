import { fetchJson, type JsonResponse } from "./http.js";
import { expect } from "vitest";
import env from "../../env.js";

/** `GET /v1/sync`; `base` defaults to the shared test server. */
export const sync = (
  token: string,
  query: Record<string, string> = {},
  base: string = env.PUBLIC_URL
) => fetchJson("GET", `${base}/v1/sync?${new URLSearchParams(query)}`, token);

/** The cursor a reader starting now begins from. */
export const syncHead = async (
  token: string,
  base?: string
): Promise<string> => {
  const { status, body } = await sync(token, {}, base);
  expect(status, JSON.stringify(body)).toBe(200);
  return body.next;
};

/** Every event after `since`, paging until `hasMore` is false. */
export const drainSync = async (
  token: string,
  since: string,
  query: Record<string, string> = {},
  base?: string
) => {
  const events: JsonResponse["body"][] = [];
  let next = since;
  for (;;) {
    const { status, body } = await sync(token, { ...query, since: next }, base);
    expect(status, JSON.stringify(body)).toBe(200);
    events.push(...body.events);
    next = body.next;
    if (!body.hasMore) return { events, next };
  }
};
