import { describe, expect, it } from "vitest";
import * as fx from "./resourceFixtures.js";
import type { z } from "zod";
import {
  AttachmentSchema,
  JoinRequestSchema,
  MessageRevisionSchema,
  MessageSchema,
  ParticipantSchema,
  PrincipalSchema,
  ReactionSummarySchema,
  SessionSchema,
  SpaceMemberSchema,
  SpaceSchema,
} from "../resources/index.js";

const cases: Array<[string, z.ZodType, Record<string, unknown>]> = [
  ["Principal", PrincipalSchema, fx.principal],
  ["Space", SpaceSchema, fx.space],
  ["SpaceMember", SpaceMemberSchema, fx.spaceMember],
  ["JoinRequest", JoinRequestSchema, fx.joinRequest],
  ["Session", SessionSchema, fx.session],
  ["Participant", ParticipantSchema, fx.participant],
  ["Attachment", AttachmentSchema, fx.attachment],
  ["ReactionSummary", ReactionSummarySchema, fx.reactionSummary],
  ["Message", MessageSchema, fx.message],
  ["MessageRevision", MessageRevisionSchema, fx.messageRevision],
];

describe("resource schemas", () => {
  it.each(cases)("%s parses a full example", (_name, schema, example) => {
    expect(schema.safeParse(example).success).toBe(true);
  });

  it.each(cases)(
    "%s rejects a missing required field",
    (_name, schema, example) => {
      for (const key of Object.keys(example)) {
        const { [key]: _omitted, ...rest } = example;
        expect(schema.safeParse(rest).success, key).toBe(false);
      }
    }
  );

  it.each(cases)("%s rejects an unknown field", (_name, schema, example) => {
    expect(schema.safeParse({ ...example, extra: 1 }).success).toBe(false);
  });

  it("Message rejects a seq given as a string", () => {
    expect(MessageSchema.safeParse({ ...fx.message, seq: "12" }).success).toBe(
      false
    );
  });

  it("Message accepts a payload of any JSON value", () => {
    expect(
      MessageSchema.safeParse({ ...fx.message, payload: { a: [1] } }).success
    ).toBe(true);
  });
});
