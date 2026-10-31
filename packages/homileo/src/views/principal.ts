import type { Principal } from "../../prisma/generated/client/index.js";
import type { Principal as PrincipalView } from "@homileo-io/sdk";

export const principalView = (row: Principal): PrincipalView => ({
  id: row.id,
  kind: row.kind,
  tereoUserId: row.tereoUserId,
  isBot: row.isBot,
  displayName: row.displayName,
  avatarUrl: row.avatarUrl,
});
