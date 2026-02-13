import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  getGatewaySocketPath,
  isGatewaySocketActive,
  isSocketPathActive,
} from "../../../src/ipc/socket";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) =>
      rm(dir, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(process.cwd(), ".xeno-socket-test-"));
  tempDirs.push(dir);
  return dir;
}

describe("ipc socket helpers", () => {
  test("isSocketPathActive returns false when socket path is missing", async () => {
    const home = await makeTempDir();
    const socketPath = join(home, "missing.sock");

    expect(await isSocketPathActive(socketPath)).toBe(false);
  });

  test("isSocketPathActive returns false for non-socket files", async () => {
    const home = await makeTempDir();
    const filePath = join(home, "not-a-socket");
    await writeFile(filePath, "hello", "utf-8");

    expect(await isSocketPathActive(filePath)).toBe(false);
  });

  test("isGatewaySocketActive returns false when standard socket is unavailable", async () => {
    const home = await makeTempDir();
    await mkdir(dirname(getGatewaySocketPath(home)), { recursive: true });

    expect(await isGatewaySocketActive(home)).toBe(false);
  });

  test("getGatewaySocketPath builds the expected socket location", async () => {
    const home = await makeTempDir();
    expect(getGatewaySocketPath(home)).toBe(join(home, ".xeno", "gateway.sock"));
  });
});
