// @module-tag int
// @module-tag platform
import { refreshProfile, setProfileLookup } from "../../utils/db/principals.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getTereo, initializeTereo, stopTereo } from "../../utils/tereo.js";
import type { Principal } from "../../utils/db/principals.js";
import { withChanges } from "../../utils/transaction.js";
import { v7 as uuidv7 } from "uuid";
import {
  filesClient,
  keepAttachments,
  setFilesClient,
  type FilesClient,
} from "../../utils/attachments.js";

const INSIDE = /inside a withChanges transaction/;

const fakeFiles = (): FilesClient & { calls: number } => {
  const fake = {
    calls: 0,
    getObject: async () => {
      fake.calls++;
      return null as never;
    },
    patchObject: async () => {
      fake.calls++;
      return null as never;
    },
    uploadObject: async () => null as never,
    presignObjectUrl: async () => null as never,
    deleteObject: async () => null as never,
  };
  return fake;
};

const principal = { id: uuidv7(), tereoUserId: uuidv7() } as Principal;

beforeAll(async () => {
  await initializeTereo();
});

afterEach(() => {
  setFilesClient(null);
  setProfileLookup(null);
});

afterAll(async () => {
  await stopTereo();
});

describe("tereo calls inside a withChanges transaction", () => {
  it("refuses a call through the tereo client", async () => {
    await expect(
      withChanges(() => getTereo().auth.getUser(uuidv7()))
    ).rejects.toThrow(INSIDE);
  });

  it("refuses a call through a replaced files client, before it runs", async () => {
    const fake = fakeFiles();
    setFilesClient(fake);

    await expect(
      withChanges(() => filesClient().getObject("bucket", uuidv7()))
    ).rejects.toThrow(INSIDE);
    expect(fake.calls).toBe(0);
  });

  it("refuses the calls whose own failures are swallowed", async () => {
    const fake = fakeFiles();
    setFilesClient(fake);
    let looked = 0;
    setProfileLookup(async () => {
      looked++;
      return null;
    });

    await expect(
      withChanges(() => keepAttachments([{ objectId: uuidv7() }]))
    ).rejects.toThrow(INSIDE);
    await expect(withChanges(() => refreshProfile(principal))).rejects.toThrow(
      INSIDE
    );
    expect(fake.calls).toBe(0);
    expect(looked).toBe(0);
  });

  it("allows a call outside it while another request's transaction is open", async () => {
    const fake = fakeFiles();
    setFilesClient(fake);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const open = new Promise<void>((resolve) => (entered = resolve));

    const transaction = withChanges(async () => {
      entered();
      await held;
    });
    await open;
    try {
      await filesClient().getObject("bucket", uuidv7());
    } finally {
      release();
      await transaction;
    }

    expect(fake.calls).toBe(1);
  });
});
