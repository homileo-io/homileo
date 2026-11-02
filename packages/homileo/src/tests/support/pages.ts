import { fetchJson } from "./http.js";

/** Follows `nextCursor` from the first page to the last; returns every row's id in order and the page count. */
export const walkPages = async (
  token: string,
  urlOf: (cursor: string | null) => string,
  idOf: (row: Record<string, unknown>) => string
): Promise<{ ids: string[]; pages: number }> => {
  const ids: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const res = await fetchJson("GET", urlOf(cursor), token);
    if (res.status !== 200) {
      throw new Error(
        `page ${pages + 1}: ${res.status} ${JSON.stringify(res.body)}`
      );
    }
    ids.push(...res.body.data.map(idOf));
    cursor = res.body.nextCursor;
    pages++;
    if (pages > 1000) throw new Error("the cursor never ended");
  } while (cursor);
  return { ids, pages };
};

/** Compares two lower-case UUIDs as Postgres orders them. */
export const byId = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;
