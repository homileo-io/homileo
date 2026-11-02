// @module-tag unit
// @module-tag events
import { EVENT_TYPES, webhookEventTypes } from "@homileo-io/sdk";
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";
import { parse } from "yaml";

// The OpenAPI spec and docs/events.md list the SDK's EVENT_TYPES; these keep
// them from drifting.
const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const types = Object.keys(EVENT_TYPES).sort();

const ticked = (cell: string) =>
  [...cell.matchAll(/`([a-z_.]+)`/g)].map((m) => m[1]);

/** The rows of the first markdown table after `marker`. */
const tableAfter = (doc: string, marker: string): string[][] => {
  const lines = doc.slice(doc.indexOf(marker)).split("\n");
  const start = lines.findIndex((l) => l.startsWith("|"));
  const rows: string[][] = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith("|")) break;
    rows.push(
      line
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim())
    );
  }
  return rows;
};

describe("event types", () => {
  it("OpenAPI's EventEnvelope type enum is EVENT_TYPES", () => {
    const schemas = parse(
      read("../../../openapi/components/events/schemas.yaml")
    ) as {
      EventEnvelope: { properties: { type: { enum: string[] } } };
    };

    expect([...schemas.EventEnvelope.properties.type.enum].sort()).toEqual(
      types
    );
  });

  it("OpenAPI's webhooks are the webhook names, private ones included", () => {
    const root = parse(read("../../../openapi/openapi.yaml")) as {
      webhooks: Record<string, unknown>;
    };

    expect(Object.keys(root.webhooks).sort()).toEqual(
      webhookEventTypes().sort()
    );
  });

  it("docs/events.md's registry table gives each type its channel and webhook flag", () => {
    const rows = tableAfter(read("../../../docs/events.md"), "## Registry");
    const listed = new Map<string, { channel: string; webhook: boolean }>();
    for (const [channel, cell, webhook] of rows) {
      for (const type of ticked(cell)) {
        listed.set(type, {
          channel: ticked(channel)[0],
          webhook: webhook === "yes",
        });
      }
    }

    expect([...listed.keys()].sort()).toEqual(types);
    for (const [type, row] of listed) {
      const definition = EVENT_TYPES[type as keyof typeof EVENT_TYPES];
      expect({ type, ...row }).toEqual({
        type,
        channel: definition.channel,
        webhook: definition.webhook,
      });
    }
  });

  it("docs/events.md's payload table covers every type once", () => {
    const rows = tableAfter(read("../../../docs/events.md"), "Payloads (");
    const listed = rows.flatMap(([cell]) => ticked(cell));

    expect([...listed].sort()).toEqual(types);
  });
});
