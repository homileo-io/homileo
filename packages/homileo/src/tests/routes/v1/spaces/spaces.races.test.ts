// @module-tag int
// @module-tag spaces
// @module-tag race
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spaceApiFixtures } from "../../../support/spaceApi.js";
import { activeKind } from "../../../../utils/kinds.js";
import { prisma } from "../../../../utils/db/prisma.js";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { v7 as uuidv7 } from "uuid";
import { tmpdir } from "os";
import { join } from "path";
import {
  ProvisioningError,
  provision,
} from "../../../../utils/provisioning/index.js";

const api = spaceApiFixtures();
let dir: string;

const settled = (p: Promise<unknown>) =>
  Promise.race([
    p.then(
      () => "settled",
      () => "settled"
    ),
    new Promise<string>((r) => setTimeout(() => r("pending"), 400)),
  ]);

describe("space creation against retiring a kind", () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "homileo-race-"));
    // No spaceKinds: applying it retires every kind not declared.
    await writeFile(
      join(dir, "empty.json"),
      JSON.stringify({ version: "1.0.0", app: "spaces-test" })
    );
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
    await api.cleanup();
  });

  it("makes provisioning wait for a create in flight, then refuse to retire a kind with a space", async () => {
    const org = api.organization();
    const kind = await api.kind(`spaces-test:${uuidv7().slice(-8)}`);
    const creator = await api.fixtures.principal();

    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    let created!: () => void;
    const inserted = new Promise<void>((r) => (created = r));

    // Transaction A, the create's first steps: read the kind FOR SHARE, insert.
    const creating = prisma.$transaction(async (tx) => {
      expect(await activeKind(tx, kind)).not.toBeNull();
      await tx.space.create({
        data: {
          organizationId: org,
          kind,
          name: "in flight",
          createdBy: creator.id,
        },
      });
      created();
      await hold;
    });
    await inserted;

    const provisioning = provision({ path: dir });
    const outcome = provisioning.catch((err: unknown) => err);
    expect(await settled(provisioning)).toBe("pending");

    release();
    await creating;

    const err = await outcome;
    expect(err).toBeInstanceOf(ProvisioningError);
    expect((err as ProvisioningError).message).toMatch(/unarchived space/);
    const row = await prisma.provisionedSpaceKind.findUniqueOrThrow({
      where: { name: kind },
    });
    expect(row.retiredAt).toBeNull();
  });
});
