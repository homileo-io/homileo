import "../preload.js";
import { disconnectDatabase } from "../utils/db/prisma.js";
import { runProvisionCli } from "./provision.js";

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "--help" || command === "-h") {
    console.error("Usage: npm run cli -- <command> [options]");
    console.error("");
    console.error("Commands:");
    console.error(
      "  provision            Apply the provisioning documents [--path <path>]"
    );
    process.exit(command ? 0 : 1);
  }

  if (command === "provision") {
    await runProvisionCli(args.slice(1));
  } else {
    console.error(`Unknown command: ${command}`);
    process.exit(1);
  }
}

main()
  .catch((e) => {
    console.error("CLI failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await disconnectDatabase();
  });
