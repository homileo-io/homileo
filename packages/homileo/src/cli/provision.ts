import { ProvisioningError, provision } from "../utils/provisioning/index.js";

/**
 * `provision [--path <path>]`: applies the provisioning documents
 * (`PROVISIONING_PATH` unless `--path` is given) and prints what changed.
 */
export async function runProvisionCli(args: string[]): Promise<void> {
  let path: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--path" && args[i + 1]) path = args[++i];
    else {
      console.error(`Unknown argument: ${args[i]}`);
      console.error("Usage: provision [--path <path>]");
      process.exit(1);
    }
  }

  try {
    const result = await provision({ path });
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    if (!(err instanceof ProvisioningError)) throw err;
    console.error("Invalid provisioning:");
    for (const problem of err.problems)
      console.error(
        `  - ${problem.file}${problem.path ? ` ${problem.path}` : ""}: ${problem.message}`
      );
    process.exit(1);
  }
}
