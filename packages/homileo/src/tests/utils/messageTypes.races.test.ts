// @module-tag int
// @module-tag provisioning
// @module-tag messages
// @module-tag race
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validatePayload } from "../../utils/messageTypes.js";
import { chatFixtures } from "../support/chatFixtures.js";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { prisma } from "../../utils/db/prisma.js";
import { db } from "../../utils/db/index.js";
import { v7 as uuidv7 } from "uuid";
import { tmpdir } from "os";
import { join } from "path";
import {
  ProvisioningError,
  provision,
} from "../../utils/provisioning/index.js";

const fixtures = chatFixtures();
const types: string[] = [];
let dir: string;

const settled = (p: Promise<unknown>) =>
  Promise.race([
    p.then(
      () => "settled",
      () => "settled"
    ),
    new Promise<string>((r) => setTimeout(() => r("pending"), 400)),
  ]);

const messageType = async () => {
  const name = `race-test:${uuidv7().slice(-12)}`;
  types.push(name);
  await prisma.provisionedMessageType.create({
    data: {
      name,
      app: "race-test",
      payloadSchema: { type: "object" },
      documentVersion: "1.0.0",
      sourceFile: "race-test.json",
    },
  });
  return name;
};

describe("posting a message type against retiring it", () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "homileo-race-"));
    // No messageTypes: applying it retires every type not declared.
    await writeFile(
      join(dir, "empty.json"),
      JSON.stringify({ version: "1.0.0", app: "race-test" })
    );
  });
  afterAll(async () => {
    await fixtures.cleanup();
    await prisma.provisionedMessageType.deleteMany({
      where: { name: { in: types } },
    });
    await rm(dir, { recursive: true, force: true });
  });

  it("makes provisioning wait for a post in flight, then refuse to retire its type", async () => {
    const type = await messageType();
    const sender = await fixtures.principal();
    const session = await fixtures.session({ createdBy: sender });

    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    let validated!: () => void;
    const inserted = new Promise<void>((r) => (validated = r));

    // The post's first steps: validate the type, insert the message.
    const posting = prisma.$transaction(async (tx) => {
      await validatePayload(type, {}, tx);
      await tx.message.create({
        data: {
          sessionId: session.id,
          seq: 1,
          senderId: sender.id,
          clientMessageId: uuidv7(),
          type,
        },
      });
      validated();
      await hold;
    });
    await inserted;

    const provisioning = provision({ path: dir });
    const outcome = provisioning.catch((err: unknown) => err);
    expect(await settled(provisioning)).toBe("pending");

    release();
    await posting;

    const err = await outcome;
    expect(err).toBeInstanceOf(ProvisioningError);
    expect((err as ProvisioningError).message).toMatch(/messages use it/);
    const row = await prisma.provisionedMessageType.findUniqueOrThrow({
      where: { name: type },
    });
    expect(row.retiredAt).toBeNull();
  });

  it("refuses a post that waited on a retirement once it commits", async () => {
    const type = await messageType();

    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const retiring = new Promise<void>((r) => (locked = r));

    // Provisioning's retirement: the type's lock exclusive, then retired_at.
    const retirement = prisma.$transaction(async (tx) => {
      await db.provisioned.holdExclusive(tx, "message_type", type);
      await tx.provisionedMessageType.update({
        where: { name: type },
        data: { retiredAt: new Date() },
      });
      locked();
      await hold;
    });
    await retiring;

    const posting = prisma.$transaction((tx) => validatePayload(type, {}, tx));
    const outcome = posting.catch((err: unknown) => err);
    expect(await settled(posting)).toBe("pending");

    release();
    await retirement;

    expect(await outcome).toMatchObject({ code: "message_type_not_found" });
  });
});
