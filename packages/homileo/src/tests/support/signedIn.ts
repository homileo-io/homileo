import { prisma } from "../../utils/db/prisma.js";
import { personToken } from "./tokens.js";
import { fetchJson } from "./http.js";
import env from "../../env.js";

export interface SignedIn {
  org: string;
  token: string;
  principalId: string;
  tereoUserId: string;
}

/** A person signed in to the shared test server; their principal exists once this returns. */
export const signIn = async (
  org: string,
  perms: string[] = []
): Promise<SignedIn> => {
  const token = personToken({ org, perms });
  const me = await fetchJson("GET", `${env.PUBLIC_URL}/v1/me`, token);
  return {
    org,
    token,
    principalId: me.body.principal.id,
    tereoUserId: me.body.principal.tereoUserId,
  };
};

/** Removes the sessions, events and outbox rows a test made in these organizations. */
export const purgeOrganizations = async (orgs: string[]) => {
  const sessions = (
    await prisma.session.findMany({
      where: { organizationId: { in: orgs } },
      select: { id: true },
    })
  ).map((s) => s.id);
  await prisma.sessionParticipant.deleteMany({
    where: { sessionId: { in: sessions } },
  });
  await prisma.session.deleteMany({ where: { id: { in: sessions } } });
  await prisma.event.deleteMany({ where: { organizationId: { in: orgs } } });
  for (const org of orgs) {
    await prisma.$executeRaw`DELETE FROM "core"."core_outbox" WHERE payload->>'organizationId' = ${org}`;
  }
};
