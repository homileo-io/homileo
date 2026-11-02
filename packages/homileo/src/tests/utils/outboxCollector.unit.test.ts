// @module-tag unit
// @module-tag events
import { collector } from "../../utils/outboxCollector.js";
import { describe, expect, it } from "vitest";
import { OutboxClient } from "@tereo-io/sdk";

type Deps = ConstructorParameters<typeof OutboxClient>[1];
type FlushTx = Parameters<ReturnType<typeof collector>["flush"]>[0];

const ORG = "00000000-0000-7000-8000-00000000000a";
const unused = () => Promise.reject(new Error("the reaper must not run"));

/** The real SDK outbox, with no database and no tereo: only its writers are called. */
const sdkOutbox = () =>
  new OutboxClient(
    {
      db: { $executeRawUnsafe: unused, $queryRawUnsafe: unused },
      table: "core.core_outbox",
      dispatch: false,
    },
    {
      webhooks: { assertEventType: () => undefined },
      audit: {},
      notifications: {},
    } as unknown as Deps
  );

/** A transaction that records the one statement `flush` sends. */
const recordingTx = () => {
  const calls: unknown[][] = [];
  const tx = {
    $executeRaw: (_strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push(values);
      return Promise.resolve(values.length);
    },
  };
  return { tx: tx as unknown as FlushTx, calls };
};

describe("the outbox collector against @tereo-io/sdk's OutboxClient", () => {
  it("takes the rows emit and audit build and flushes them in one statement, in order", async () => {
    const outbox = sdkOutbox();
    const pending = collector();

    await outbox.emit(pending.client, {
      organizationId: ORG,
      eventType: "homileo.message.created",
      entityType: "message",
      entityId: "m-1",
      data: { eventId: "1" },
    });
    await outbox.audit(pending.client, {
      organizationId: ORG,
      userId: "00000000-0000-7000-8000-000000000001",
      action: "UPDATE",
      entityType: "session",
      entityId: "s-1",
    });
    const { tx, calls } = recordingTx();
    await pending.flush(tx);

    expect(calls).toHaveLength(1);
    const [ids, destinations, payloads] = calls[0] as string[][];
    expect(destinations).toEqual(["webhook", "audit"]);
    expect(ids.every((id) => /^[0-9a-f-]{36}$/.test(id))).toBe(true);
    expect(JSON.parse(payloads[0])).toMatchObject({
      eventType: "homileo.message.created",
      entityId: "m-1",
    });
    expect(JSON.parse(payloads[1])).toMatchObject({
      action: "UPDATE",
      entityId: "s-1",
    });
  });

  it("flushes nothing twice, and nothing when nothing was written", async () => {
    const outbox = sdkOutbox();
    const pending = collector();
    const { tx, calls } = recordingTx();

    await pending.flush(tx);
    await outbox.emit(pending.client, {
      organizationId: ORG,
      eventType: "homileo.message.created",
      entityType: "message",
      entityId: "m-1",
      data: {},
    });
    await pending.flush(tx);
    await pending.flush(tx);

    expect(calls).toHaveLength(1);
  });

  it("lets the SDK's own validation through: an invalid audit entry is refused before any row", async () => {
    const outbox = sdkOutbox();
    const pending = collector();

    await expect(
      outbox.audit(pending.client, {
        userId: "u",
        action: "NOT_AN_ACTION",
        entityType: "session",
        entityId: "s-1",
      } as unknown as Parameters<OutboxClient["audit"]>[1])
    ).rejects.toThrow();
    const { tx, calls } = recordingTx();
    await pending.flush(tx);

    expect(calls).toEqual([]);
  });
});
