import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHome } from "../../src/home";

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

async function makeTempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "xeno-home-test-"));
  tempDirs.push(dir);
  return dir;
}

describe("createHome", () => {
  test("scaffolds home files and memory directory", async () => {
    const home = await makeTempHome();

    await createHome(home);

    const expectedFiles = [
      "CLAUDE.md",
      "BOOTSTRAP.md",
      "HEARTBEAT.md",
      "IDENTITY.md",
      "MEMORY.md",
      "SOUL.md",
      "TOOLS.md",
      "USER.md",
      ".claude/settings.local.json",
      ".claude/skills/run-cron-task/SKILL.md",
      ".claude/skills/xeno-voice/SKILL.md",
      ".claude/skills/xeno-voice/scripts/xeno-voice",
    ];

    for (const relativePath of expectedFiles) {
      const file = await stat(join(home, relativePath));
      expect(file.isFile()).toBe(true);
    }

    const memoryDirStat = await Bun.file(join(home, "memory")).stat();
    expect(memoryDirStat.isDirectory()).toBe(true);

    const mediaDirStat = await Bun.file(join(home, "media")).stat();
    expect(mediaDirStat.isDirectory()).toBe(true);

    const receivedMediaDirStat = await Bun.file(join(home, "media", "received")).stat();
    expect(receivedMediaDirStat.isDirectory()).toBe(true);

    const xenoVoiceScriptStat = await stat(
      join(home, ".claude/skills/xeno-voice/scripts/xeno-voice"),
    );
    expect((xenoVoiceScriptStat.mode & 0o111) !== 0).toBe(true);
  });

  test("does not overwrite existing files", async () => {
    const home = await makeTempHome();
    const identityPath = join(home, "IDENTITY.md");
    const sentinel = "existing identity";

    await Bun.write(identityPath, sentinel);
    await createHome(home);

    const content = await readFile(identityPath, "utf-8");
    expect(content).toBe(sentinel);
  });

  test("does not create BOOTSTRAP.md when CLAUDE.md already exists", async () => {
    const home = await makeTempHome();
    await Bun.write(join(home, "CLAUDE.md"), "existing claude");

    await createHome(home);

    expect(await Bun.file(join(home, "BOOTSTRAP.md")).exists()).toBe(false);
  });

  test("always overwrites CLAUDE.md and skill files only", async () => {
    const home = await makeTempHome();
    const claudePath = join(home, "CLAUDE.md");
    const runCronTaskSkillPath = join(home, ".claude/skills/run-cron-task/SKILL.md");
    const toolsPath = join(home, "TOOLS.md");

    await createHome(home);

    await Bun.write(claudePath, "custom claude");
    await Bun.write(runCronTaskSkillPath, "custom run cron task skill");
    await Bun.write(toolsPath, "custom tools");

    await createHome(home);

    expect(await readFile(claudePath, "utf-8")).not.toBe("custom claude");
    expect(await readFile(runCronTaskSkillPath, "utf-8")).not.toBe("custom run cron task skill");
    expect(await readFile(toolsPath, "utf-8")).toBe("custom tools");
  });

  test("removes legacy skills/heartbeat/SKILL.md when scaffolding", async () => {
    const home = await makeTempHome();
    const legacySkillPath = join(home, "skills/heartbeat/SKILL.md");
    const legacySkillDir = join(home, "skills/heartbeat");

    await mkdir(legacySkillDir, { recursive: true });
    await Bun.write(legacySkillPath, "legacy heartbeat skill");

    await createHome(home);

    expect(await Bun.file(legacySkillPath).exists()).toBe(false);
    expect(await Bun.file(legacySkillDir).exists()).toBe(false);
    expect(await Bun.file(join(home, ".claude/skills/run-cron-task/SKILL.md")).exists()).toBe(true);
  });
});
