// @module-tag int
// @module-tag provisioning
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { prisma } from "../../utils/db/prisma.js";
import { execFile } from "child_process";
import { fileURLToPath } from "url";
import { promisify } from "util";
import { tmpdir } from "os";
import path from "path";

const run = promisify(execFile);
const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.."
);
const dirs: string[] = [];

const cli = async (...args: string[]) =>
  run("npx", ["tsx", "src/cli/index.ts", ...args], {
    cwd: packageRoot,
    env: process.env,
  }).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (err: { code: number; stdout: string; stderr: string }) => err
  );

const provisioningDir = async (docs: Record<string, unknown>) => {
  const dir = await mkdtemp(path.join(tmpdir(), "homileo-cli-"));
  dirs.push(dir);
  for (const [file, doc] of Object.entries(docs))
    await writeFile(path.join(dir, file), JSON.stringify(doc));
  return dir;
};

const wipe = async () => {
  await prisma.provisionedSpaceKind.deleteMany();
  await prisma.provisionedMessageType.deleteMany();
};

describe("cli provision", () => {
  beforeEach(wipe);
  afterAll(async () => {
    await wipe();
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  });

  it("exits 1 and prints every problem for an invalid set", async () => {
    const dir = await provisioningDir({
      "a.json": { version: "nope", app: "a" },
      "b.json": { version: "1.0.0", app: "B" },
    });

    const result = await cli("provision", "--path", dir);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("a.json version");
    expect(result.stderr).toContain("b.json app");
  });

  it("exits 0 and reports what it applied", async () => {
    const dir = await provisioningDir({
      "a.json": {
        version: "1.0.0",
        app: "clitest",
        messageTypes: [
          { name: "clitest:card", payloadSchema: { type: "object" } },
        ],
      },
    });

    const result = await cli("provision", "--path", dir);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ applied: 1, retired: [] });
  });
});
