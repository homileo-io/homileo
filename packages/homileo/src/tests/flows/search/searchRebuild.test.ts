// @module-tag int
// @module-tag search
// @module-tag provisioning
import { processSearchTextRebuild } from "../../../jobs/searchTextRebuild.js";
import { applyDocuments } from "../../../utils/provisioning/apply.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { searchFixtures } from "../../support/searchApi.js";
import { invalidateKinds } from "../../../utils/kinds.js";
import { prisma } from "../../../utils/db/prisma.js";
import { signIn } from "../../support/signedIn.js";
import { fetchJson } from "../../support/http.js";
import { v7 as uuidv7 } from "uuid";

const s = searchFixtures();

beforeAll(s.start);
afterAll(async () => {
  await prisma.provisionedSpaceKind.deleteMany({
    where: { app: "rebuild-test" },
  });
  invalidateKinds();
  await s.cleanup();
});

const KIND = `rebuild-test:${uuidv7().slice(-12)}`;

const declare = async (metadata: string[]) => {
  await applyDocuments([
    {
      file: "rebuild-test.json",
      document: {
        version: "1.0.0",
        app: "rebuild-test",
        spaceKinds: [
          {
            name: KIND,
            defaults: {
              visibility: "public",
              join: "open",
              posting: "members",
            },
            search: { metadata },
          },
        ],
      },
    },
  ] as Parameters<typeof applyDocuments>[0]);
  invalidateKinds();
};

describe("search text rebuild", () => {
  it("follows the kind's declared keys through a re-apply and a rebuild", async () => {
    const org = s.organization();
    const user = await signIn(org, ["homileo.spaces.write"]);
    await declare([]);
    const space = await fetchJson("POST", `${s.url()}/v1/spaces`, user.token, {
      kind: KIND,
      name: "Acme",
    });
    expect(space.status, JSON.stringify(space.body)).toBe(201);
    const created = await fetchJson(
      "POST",
      `${s.url()}/v1/sessions`,
      user.token,
      {
        spaceId: space.body.space.id,
        name: "Ticket",
        metadata: { customerName: "Ada" },
      }
    );
    expect(created.status).toBe(201);
    const id: string = created.body.session.id;
    const hits = async () => {
      const res = await s.searchSessions(user.token, { q: "ada" });
      expect(res.status).toBe(200);
      return res.body.data.map(
        (h: { session: { id: string } }) => h.session.id
      );
    };

    expect(await hits()).toEqual([]);

    await declare(["customerName"]);
    await processSearchTextRebuild({ settleMs: 0 });
    expect(await hits()).toEqual([id]);

    await declare([]);
    await processSearchTextRebuild({ settleMs: 0 });
    expect(await hits()).toEqual([]);
  });
});
