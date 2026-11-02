// @module-tag int
// @module-tag search
import { removeKinds, provisionKind, startV1App } from "../../support/v1App.js";
import { purgeOrganizations, signIn } from "../../support/signedIn.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chatFixtures } from "../../support/chatFixtures.js";
import { prisma } from "../../../utils/db/prisma.js";
import { fetchJson } from "../../support/http.js";
import { v7 as uuidv7 } from "uuid";

const fixtures = chatFixtures();
const orgs: string[] = [];
let app: Awaited<ReturnType<typeof startV1App>>;

beforeAll(async () => {
  app = await startV1App();
});

afterAll(async () => {
  await app.close();
  await removeKinds();
  await fixtures.cleanup();
  await purgeOrganizations(orgs);
});

const searchTextOf = async (table: "spaces" | "sessions", id: string) => {
  const rows =
    table === "spaces"
      ? await prisma.$queryRaw<Array<{ search_text: string }>>`
          SELECT search_text FROM "chat"."spaces" WHERE id = ${id}::uuid`
      : await prisma.$queryRaw<Array<{ search_text: string }>>`
          SELECT search_text FROM "chat"."sessions" WHERE id = ${id}::uuid`;
  return rows[0]?.search_text;
};

const setup = async () => {
  const org = uuidv7();
  orgs.push(org);
  fixtures.organization(org);
  const kind = await provisionKind({
    search: { metadata: ["customerName"] },
    defaults: { visibility: "public", join: "open", posting: "members" },
  });
  const user = await signIn(org, ["homileo.spaces.write"]);
  return { kind, user };
};

describe("search_text", () => {
  it("is the space's name and declared metadata keys, kept on update", async () => {
    const { kind, user } = await setup();

    const created = await fetchJson(
      "POST",
      `${app.url}/v1/spaces`,
      user.token,
      {
        kind,
        name: "Acme",
        metadata: { customerName: "Ada", other: "zzz" },
      }
    );
    expect(created.status).toBe(201);
    const id: string = created.body.space.id;
    expect(await searchTextOf("spaces", id)).toBe("Acme Ada");

    const patched = await fetchJson(
      "PATCH",
      `${app.url}/v1/spaces/${id}`,
      user.token,
      { metadata: { customerName: "Grace" } }
    );
    expect(patched.status).toBe(200);
    expect(await searchTextOf("spaces", id)).toBe("Acme Grace");
  });

  it("is the session's name and its space kind's declared keys, kept on update", async () => {
    const { kind, user } = await setup();
    const space = await fetchJson("POST", `${app.url}/v1/spaces`, user.token, {
      kind,
      name: "Acme",
    });
    expect(space.status).toBe(201);

    const created = await fetchJson(
      "POST",
      `${app.url}/v1/sessions`,
      user.token,
      {
        spaceId: space.body.space.id,
        name: "Ticket",
        metadata: { customerName: "Ada" },
      }
    );
    expect(created.status).toBe(201);
    const id: string = created.body.session.id;
    expect(await searchTextOf("sessions", id)).toBe("Ticket Ada");

    const patched = await fetchJson(
      "PATCH",
      `${app.url}/v1/sessions/${id}`,
      user.token,
      { name: "Ticket 2" }
    );
    expect(patched.status).toBe(200);
    expect(await searchTextOf("sessions", id)).toBe("Ticket 2 Ada");
  });

  it("is only the name for a session with no space", async () => {
    const { user } = await setup();

    const created = await fetchJson(
      "POST",
      `${app.url}/v1/sessions`,
      user.token,
      { name: "Ad hoc", metadata: { customerName: "Ada" } }
    );

    expect(created.status).toBe(201);
    expect(await searchTextOf("sessions", created.body.session.id)).toBe(
      "Ad hoc"
    );
  });

  it("is empty for a direct session", async () => {
    const { user } = await setup();
    const other = await signIn(user.org);

    const created = await fetchJson(
      "POST",
      `${app.url}/v1/sessions/direct`,
      user.token,
      { principalId: other.principalId }
    );

    expect([200, 201]).toContain(created.status);
    expect(await searchTextOf("sessions", created.body.session.id)).toBe("");
  });
});
