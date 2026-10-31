import { provisionKind, removeKinds, type KindOptions } from "./v1App.js";
import { prisma } from "../../utils/db/prisma.js";
import { chatFixtures } from "./chatFixtures.js";
import { personToken } from "./tokens.js";
import { v7 as uuidv7 } from "uuid";

/** Tracks what a test file makes through the API and removes it afterwards. */
export const spaceApiFixtures = () => {
  const fixtures = chatFixtures();
  const organizations: string[] = [];
  const tereoUsers: string[] = [];

  const organization = () => {
    const id = uuidv7();
    organizations.push(id);
    fixtures.organization(id);
    return id;
  };

  /** A person with a principal row (so fixtures can make them a member) and a token. */
  const actor = async (org: string, perms: string[] = []) => {
    const principal = await fixtures.principal();
    return {
      principal,
      token: personToken({ userId: principal.tereoUserId!, org, perms }),
    };
  };

  const kind = (name: string, o: KindOptions = {}) => {
    tereoUsers.push(...(o.bots ?? []));
    return provisionKind({ ...o, name });
  };

  const cleanup = async () => {
    await prisma.event.deleteMany({
      where: { organizationId: { in: organizations } },
    });
    for (const org of organizations) {
      await prisma.$executeRaw`DELETE FROM "core"."core_outbox" WHERE payload->>'organizationId' = ${org}`;
    }
    await fixtures.cleanup();
    await prisma.principal.deleteMany({
      where: { tereoUserId: { in: tereoUsers } },
    });
    await removeKinds();
  };

  return { fixtures, organization, actor, kind, cleanup };
};
