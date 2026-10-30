// @module-tag int
// @module-tag spaces
import { spaceApiFixtures, startV1App } from "../../../support/spaceApi.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../../../utils/db/prisma.js";
import { botToken } from "../../../support/tokens.js";
import { fetchJson } from "../../../support/http.js";
import { v7 as uuidv7 } from "uuid";

const api = spaceApiFixtures();
const { fixtures } = api;
let url: string;
let close: () => Promise<unknown>;

const create = (token: string, body: object) =>
  fetchJson("POST", `${url}/v1/spaces`, token, body);
const list = (token: string, query = "") =>
  fetchJson("GET", `${url}/v1/spaces${query}`, token);
const WRITE = ["homileo.spaces.write"];
const kindName = () => `spaces-test:${uuidv7().slice(-8)}`;
const idsOf = (r: { body: { data: Array<{ id: string }> } }) =>
  r.body.data.map((s) => s.id);

describe("/v1/spaces", () => {
  beforeAll(async () => {
    ({ url, close } = await startV1App());
  });
  afterAll(async () => {
    await close();
    await api.cleanup();
  });

  describe("POST /v1/spaces", () => {
    it("creates a space of the default kind, with the creator as its owner", async () => {
      const org = api.organization();
      const { principal, token } = await api.actor(org, WRITE);

      const res = await create(token, {
        name: "  General  ",
        description: "Everyone",
        externalRef: "ref-1",
        metadata: { team: "core" },
      });

      expect(res.status).toBe(201);
      expect(res.body.space).toMatchObject({
        organizationId: org,
        kind: "default",
        name: "General",
        description: "Everyone",
        visibility: "members",
        joinPolicy: "invite",
        postPolicy: "members",
        state: null,
        externalRef: "ref-1",
        metadata: { team: "core" },
        createdBy: principal.id,
        archivedAt: null,
      });
      const members = await prisma.spaceMember.findMany({
        where: { spaceId: res.body.space.id },
      });
      expect(members).toMatchObject([{ userId: principal.id, role: "owner" }]);
    });

    it("applies a provisioned kind's defaults and adds its bots as members", async () => {
      const org = api.organization();
      const botUser = uuidv7();
      const kind = await api.kind(kindName(), {
        defaults: { visibility: "public", join: "open", posting: "moderators" },
        bots: [botUser],
      });
      const { principal, token } = await api.actor(org, WRITE);

      const res = await create(token, { kind, name: "Case 1" });

      expect(res.status).toBe(201);
      expect(res.body.space).toMatchObject({
        kind,
        visibility: "public",
        joinPolicy: "open",
        postPolicy: "moderators",
      });
      const bot = await prisma.principal.findUniqueOrThrow({
        where: { tereoUserId: botUser },
      });
      expect(bot.isBot).toBe(true);
      const members = await prisma.spaceMember.findMany({
        where: { spaceId: res.body.space.id },
      });
      expect(members.map((m) => [m.userId, m.role]).sort()).toEqual(
        [
          [principal.id, "owner"],
          [bot.id, "member"],
        ].sort()
      );
    });

    it("does not add a kind's bot twice when the bot is the creator", async () => {
      const org = api.organization();
      const botUser = uuidv7();
      const kind = await api.kind(kindName(), { bots: [botUser] });
      // A service account that may create spaces.
      const token = `${botToken({ userId: botUser, org })}|perms=${WRITE[0]}`;

      const res = await create(token, { kind, name: "By the bot" });

      expect(res.status).toBe(201);
      const members = await prisma.spaceMember.findMany({
        where: { spaceId: res.body.space.id },
      });
      expect(members).toHaveLength(1);
      expect(members[0].role).toBe("owner");
    });

    it("refuses a setting the kind does not let spaces override", async () => {
      const org = api.organization();
      const kind = await api.kind(kindName(), { overridable: ["visibility"] });
      const { token } = await api.actor(org, WRITE);

      const same = await create(token, {
        kind,
        name: "x",
        joinPolicy: "invite",
      });
      const allowed = await create(token, {
        kind,
        name: "y",
        visibility: "public",
      });

      expect(same.status).toBe(400);
      expect(same.body.error).toBe("setting_not_overridable");
      expect(allowed.status).toBe(201);
      expect(allowed.body.space.visibility).toBe("public");
    });

    it("returns 400 kind_not_found for a retired kind", async () => {
      const org = api.organization();
      const retired = await api.kind(kindName(), { retired: true });
      const { token } = await api.actor(org, WRITE);

      const gone = await create(token, { kind: retired, name: "x" });
      const unknown = await create(token, { kind: "nope:never", name: "x" });

      expect(gone.status).toBe(400);
      expect(gone.body.error).toBe("kind_not_found");
      expect(unknown.body.error).toBe("kind_not_found");
    });

    it("accepts a state the kind declares and refuses others", async () => {
      const org = api.organization();
      const kind = await api.kind(kindName(), { states: ["open", "closed"] });
      const { token } = await api.actor(org, WRITE);

      const ok = await create(token, { kind, name: "a", state: "open" });
      const bad = await create(token, { kind, name: "b", state: "lost" });
      const onDefault = await create(token, { name: "c", state: "open" });

      expect(ok.status).toBe(201);
      expect(ok.body.space.state).toBe("open");
      expect(bad.status).toBe(400);
      expect(bad.body.error).toBe("invalid_state");
      expect(onDefault.body.error).toBe("invalid_state");
    });

    it("returns 409 external_ref_taken for a duplicate within the kind and organization", async () => {
      const org = api.organization();
      const other = api.organization();
      const { token } = await api.actor(org, WRITE);
      const { token: otherToken } = await api.actor(other, WRITE);
      const first = await create(token, { name: "a", externalRef: "r" });
      expect(first.status).toBe(201);

      const dup = await create(token, { name: "b", externalRef: "r" });
      const elsewhere = await create(otherToken, {
        name: "c",
        externalRef: "r",
      });
      const none = await create(token, { name: "d" });
      const none2 = await create(token, { name: "e" });

      expect(dup.status).toBe(409);
      expect(dup.body.error).toBe("external_ref_taken");
      expect(elsewhere.status).toBe(201);
      expect([none.status, none2.status]).toEqual([201, 201]);
    });

    it("returns 400 invalid_request with issues for a malformed body", async () => {
      const org = api.organization();
      const { token } = await api.actor(org, WRITE);

      const res = await create(token, { name: "" });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_request");
      expect(res.body.issues[0].path).toBe("name");
    });
  });

  describe("GET /v1/spaces", () => {
    it("lists member spaces by default and readable ones on request", async () => {
      const org = api.organization();
      const kind = await api.kind(kindName(), {
        grants: [{ permission: "spaces-test.read", access: "read" }],
      });
      const { principal, token } = await api.actor(org, ["spaces-test.read"]);
      const owner = await fixtures.principal();
      const mine = await fixtures.space({ org });
      await fixtures.member(mine, principal, "member");
      const pub = await fixtures.space({ org, visibility: "public" });
      const granted = await fixtures.space({ org, kind });
      const hidden = await fixtures.space({ org, createdBy: owner });
      await fixtures.member(hidden, owner, "owner");

      const member = await list(token);
      const readable = await list(token, "?membership=readable");

      expect(idsOf(member)).toEqual([mine.id]);
      expect(member.body.data[0].role).toBe("member");
      expect(idsOf(readable).sort()).toEqual(
        [mine.id, pub.id, granted.id].sort()
      );
      const roles = Object.fromEntries(
        readable.body.data.map((s: { id: string; role: string }) => [
          s.id,
          s.role,
        ])
      );
      expect(roles).toEqual({
        [mine.id]: "member",
        [pub.id]: null,
        [granted.id]: null,
      });
      expect(member.body.nextCursor).toBeNull();
    });

    it("lists every space of the organization to an admin, and none of another", async () => {
      const org = api.organization();
      const other = api.organization();
      const { token } = await api.actor(org, ["homileo.chat.admin"]);
      const a = await fixtures.space({ org });
      const b = await fixtures.space({ org, visibility: "members" });
      await fixtures.space({ org: other, visibility: "public" });

      const res = await list(token, "?membership=readable");
      const mine = await list(token);

      expect(idsOf(res).sort()).toEqual([a.id, b.id].sort());
      expect(mine.body.data).toEqual([]);
    });

    it("never lists another member's members-only space", async () => {
      const org = api.organization();
      const { principal, token } = await api.actor(org);
      const other = await fixtures.principal();
      const theirs = await fixtures.space({ org, createdBy: other });
      await fixtures.member(theirs, other, "owner");
      const shared = await fixtures.space({ org });
      await fixtures.member(shared, principal);
      await fixtures.member(shared, other);

      const res = await list(token, "?membership=readable");

      expect(idsOf(res)).toEqual([shared.id]);
    });

    it("pages over three pages with a cursor", async () => {
      const org = api.organization();
      const { principal, token } = await api.actor(org);
      const made = [];
      for (let i = 0; i < 5; i++) {
        const s = await fixtures.space({ org });
        await fixtures.member(s, principal);
        made.push(s);
      }
      const expected = [...made]
        .sort(
          (a, b) =>
            b.createdAt.getTime() - a.createdAt.getTime() ||
            (a.id < b.id ? 1 : -1)
        )
        .map((s) => s.id);

      const seen: string[] = [];
      const sizes: number[] = [];
      let cursor: string | null = null;
      do {
        const res: Awaited<ReturnType<typeof list>> = await list(
          token,
          `?limit=2${cursor ? `&cursor=${cursor}` : ""}`
        );
        expect(res.status).toBe(200);
        sizes.push(res.body.data.length);
        seen.push(...idsOf(res));
        cursor = res.body.nextCursor;
      } while (cursor);

      expect(sizes).toEqual([2, 2, 1]);
      expect(seen).toEqual(expected);
    });

    it("filters by externalRef and kind, and hides archived spaces unless asked", async () => {
      const org = api.organization();
      const { principal, token } = await api.actor(org, WRITE);
      const a = await create(token, { name: "a", externalRef: "ref-a" });
      await create(token, { name: "b", externalRef: "ref-b" });
      const kind = await api.kind(kindName());
      const typed = await create(token, { name: "c", kind });
      const archived = await fixtures.space({ org, archived: true });
      await fixtures.member(archived, principal);

      const byRef = await list(token, "?externalRef=ref-a");
      const byKind = await list(token, `?kind=${kind}`);
      const live = await list(token);
      const all = await list(token, "?includeArchived=true");

      expect(idsOf(byRef)).toEqual([a.body.space.id]);
      expect(idsOf(byKind)).toEqual([typed.body.space.id]);
      expect(live.body.data).toHaveLength(3);
      expect(all.body.data).toHaveLength(4);
    });

    it.each([
      ["a malformed cursor", "?cursor=!!!"],
      [
        "a cursor of the wrong shape",
        `?cursor=${Buffer.from('[1,"x"]').toString("base64url")}`,
      ],
      ["a limit past 100", "?limit=101"],
      ["an unknown membership", "?membership=all"],
      ["a non-boolean includeArchived", "?includeArchived=yes"],
    ])("returns 400 for %s", async (_label, query) => {
      const { token } = await api.actor(api.organization());

      const res = await list(token, query);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_request");
    });
  });
});
