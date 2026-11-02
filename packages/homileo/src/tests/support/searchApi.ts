import type { Session, Space } from "../../../prisma/generated/client/index.js";
import { purgeOrganizations, signIn } from "./signedIn.js";
import { removeKinds, startV1App } from "./v1App.js";
import { prisma } from "../../utils/db/prisma.js";
import { chatFixtures } from "./chatFixtures.js";
import { sendMessage } from "./messageApi.js";
import { fetchJson } from "./http.js";
import { v7 as uuidv7 } from "uuid";

export interface RoomOptions {
  kind?: string;
  visibility?: "public" | "members";
  sessionMetadata?: Record<string, unknown>;
  spaceMetadata?: Record<string, unknown>;
}

/**
 * Search tests' rooms, each in an organization of its own so a search sees only what the test
 * made, served from the test's own `/v1` app (`startV1App`) so provisioned kinds reach it.
 */
export const searchFixtures = () => {
  const fixtures = chatFixtures();
  const orgs: string[] = [];
  let app: Awaited<ReturnType<typeof startV1App>> | undefined;
  let seq = 1_000_000;

  const url = () => {
    if (!app) throw new Error("searchFixtures: call start() in beforeAll");
    return app.url;
  };

  const start = async () => {
    app = await startV1App();
  };

  const organization = () => {
    const org = uuidv7();
    orgs.push(org);
    fixtures.organization(org);
    return org;
  };

  /** A session in `space` (a new public space by default) and a participant who sends into it. */
  const room = async (
    o: RoomOptions & { org?: string; space?: Space } = {}
  ) => {
    const org = o.org ?? o.space?.organizationId ?? organization();
    const space =
      o.space ??
      (await fixtures.space({
        org,
        kind: o.kind,
        visibility: o.visibility ?? "public",
      }));
    if (o.spaceMetadata) {
      await prisma.space.update({
        where: { id: space.id },
        data: { metadata: o.spaceMetadata as object },
      });
    }
    const session = await fixtures.session({ space, access: "space" });
    if (o.sessionMetadata) {
      await prisma.session.update({
        where: { id: session.id },
        data: { metadata: o.sessionMetadata as object },
      });
    }
    const sender = await signIn(org);
    await fixtures.participant(session, { id: sender.principalId });
    return {
      org,
      space,
      session,
      sender,
      send: (body: string, extra: Record<string, unknown> = {}) =>
        sendTo(session, sender.token, body, extra),
    };
  };

  /** Sends through the API and returns the new message's id. */
  const sendTo = async (
    session: Pick<Session, "id">,
    token: string,
    body: string,
    extra: Record<string, unknown> = {}
  ): Promise<string> => {
    const sent = await sendMessage(
      session.id,
      token,
      { body, ...extra },
      url()
    );
    if (sent.status !== 201) {
      throw new Error(
        `send failed: ${sent.status} ${JSON.stringify(sent.body)}`
      );
    }
    return sent.body.message.id;
  };

  /** Writes a message row directly, for bulk or attachment-only fixtures. */
  const insert = async (
    session: Pick<Session, "id">,
    senderId: string,
    bodyText: string | null
  ): Promise<string> => {
    const row = await prisma.message.create({
      data: {
        sessionId: session.id,
        seq: seq++,
        senderId,
        clientMessageId: uuidv7(),
        body: bodyText,
        bodyText,
      },
    });
    return row.id;
  };

  const attach = (messageId: string, filename: string) =>
    prisma.attachment.create({
      data: {
        messageId,
        tereoObjectId: uuidv7(),
        filename,
        contentType: "application/octet-stream",
        size: 10,
      },
    });

  const search = (token: string, params: Record<string, string>) =>
    fetchJson(
      "GET",
      `${url()}/v1/search/messages?${new URLSearchParams(params)}`,
      token
    );

  const searchSessions = (token: string, params: Record<string, string>) =>
    fetchJson(
      "GET",
      `${url()}/v1/search/sessions?${new URLSearchParams(params)}`,
      token
    );

  const searchPrincipals = (token: string, params: Record<string, string>) =>
    fetchJson(
      "GET",
      `${url()}/v1/search/principals?${new URLSearchParams(params)}`,
      token
    );

  const cleanup = async () => {
    await app?.close();
    await removeKinds();
    await fixtures.cleanup();
    await purgeOrganizations(orgs);
  };

  return {
    fixtures,
    url,
    start,
    organization,
    room,
    sendTo,
    insert,
    attach,
    search,
    searchSessions,
    searchPrincipals,
    cleanup,
  };
};

/** The message ids of a search response, in order. */
export const hitIds = (body: { data: Array<{ message: { id: string } }> }) =>
  body.data.map((h) => h.message.id);

/** The `type:id` of each hit of a session search response, in order. */
export const sessionHitIds = (body: {
  data: Array<{
    type: string;
    space?: { id: string };
    session?: { id: string };
  }>;
}) => body.data.map((h) => `${h.type}:${(h.space ?? h.session)!.id}`);
