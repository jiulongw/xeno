import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getConfigPath,
  loadConfigFromPath,
  resolveHome,
  resolveTelegramBotToken,
} from "../../src/config";

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
  const dir = await mkdtemp(join(tmpdir(), "xeno-config-test-"));
  tempDirs.push(dir);
  return dir;
}

describe("config", () => {
  test("returns empty config when file is missing", async () => {
    const dir = await makeTempDir();
    const missingPath = join(dir, "missing.json");

    const config = await loadConfigFromPath(missingPath);
    expect(config).toEqual({});
  });

  test("loads default_home and telegram_bot_token", async () => {
    const dir = await makeTempDir();
    const configPath = join(dir, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        default_home: "/tmp/xeno-from-config",
        telegram_bot_token: "token-from-config",
      }),
      "utf-8",
    );

    const config = await loadConfigFromPath(configPath);
    expect(config).toEqual({
      defaultHome: "/tmp/xeno-from-config",
      telegramBotToken: "token-from-config",
    });
  });

  test("throws on invalid JSON", async () => {
    const dir = await makeTempDir();
    const configPath = join(dir, "config.json");
    await writeFile(configPath, "{", "utf-8");

    await expect(loadConfigFromPath(configPath)).rejects.toThrow("Invalid JSON");
  });

  test("throws when default_home is not a string", async () => {
    const dir = await makeTempDir();
    const configPath = join(dir, "config.json");
    await writeFile(configPath, JSON.stringify({ default_home: 42 }), "utf-8");

    await expect(loadConfigFromPath(configPath)).rejects.toThrow('Expected "default_home" in');
  });

  test("resolveHome prefers --home over config default_home", () => {
    const home = resolveHome("/tmp/from-cli", {
      defaultHome: "/tmp/from-config",
    });

    expect(home).toBe("/tmp/from-cli");
  });

  test("resolveHome uses config default_home when --home is omitted", () => {
    const home = resolveHome(undefined, {
      defaultHome: "/tmp/from-config",
    });

    expect(home).toBe("/tmp/from-config");
  });

  test("resolveHome throws when neither --home nor default_home is set", () => {
    const configPath = getConfigPath("/tmp/fake-home");
    expect(() => resolveHome(undefined, {}, configPath)).toThrow(
      `Missing home. Pass --home <path> or set default_home in ${configPath}.`,
    );
  });

  test("resolveTelegramBotToken gives precedence to TELEGRAM_BOT_TOKEN env var", () => {
    const token = resolveTelegramBotToken(
      {
        telegramBotToken: "from-config",
      },
      {
        TELEGRAM_BOT_TOKEN: "from-env",
      } as NodeJS.ProcessEnv,
    );

    expect(token).toBe("from-env");
  });

  test("resolveTelegramBotToken falls back to config token", () => {
    const token = resolveTelegramBotToken(
      {
        telegramBotToken: "from-config",
      },
      {} as NodeJS.ProcessEnv,
    );

    expect(token).toBe("from-config");
  });
});
