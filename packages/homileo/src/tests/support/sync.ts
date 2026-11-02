import { encodeSyncCursor } from "../../realtime/syncCursor.js";
import { fetchJson, type JsonResponse } from "./http.js";
import { db } from "../../utils/db/index.js";
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

/**
 * An `until` covering everything committed so far: a drain passing it waits out a
 * transaction still open elsewhere instead of stopping short of what this test wrote.
 */
export const syncTail = async (): Promise<string> =>
  encodeSyncCursor(await db.events.tail());

/** Pages a loop may take before it fails instead of spinning until the test's timeout. */
const MAX_PAGES = 200;

/**
 * The documented reconnect loop: pages from `since` until `hasMore` is false, and waits
 * `backoffMs` only after a page whose `next` did not advance (an older transaction still
 * open). An empty page that advanced, as a page cut at the scan cap is, goes on at once.
 */
const pageThrough = async (
  token: string,
  since: string,
  query: Record<string, string>,
  o: { backoffMs?: number; base?: string; maxPages?: number } = {}
) => {
  const events: JsonResponse["body"][] = [];
  let next = since;
  for (let pages = 1; ; pages++) {
    const { status, body } = await sync(
      token,
      { ...query, since: next },
      o.base
    );
    expect(status, JSON.stringify(body)).toBe(200);
    events.push(...body.events);
    const advanced = body.next !== next;
    next = body.next;
    if (!body.hasMore) return { events, next, pages };
    if (pages >= (o.maxPages ?? MAX_PAGES)) {
      throw new Error(`/sync still had more after ${pages} pages`);
    }
    if (!advanced) {
      await new Promise((resolve) => setTimeout(resolve, o.backoffMs ?? 100));
    }
  }
};

/** Every event after `since`, paging until `hasMore` is false; `until` in `query` waits for it. */
export const drainSync = (
  token: string,
  since: string,
  query: Record<string, string> = {},
  base?: string
) => pageThrough(token, since, query, { base });

/** The reconnect loop with the `until` a socket's `ready` or `subscribe` ack gave. */
export const catchUp = (
  token: string,
  since: string,
  until: string,
  query: Record<string, string> = {},
  backoffMs = 100,
  base?: string
) => pageThrough(token, since, { ...query, until }, { backoffMs, base });
