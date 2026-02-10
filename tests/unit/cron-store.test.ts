import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CronStore } from "../../src/cron/store";
import type { CronTask } from "../../src/cron/types";

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
  const dir = await mkdtemp(join(tmpdir(), "xeno-cron-store-test-"));
  tempDirs.push(dir);
  return dir;
}

function makeTask(): CronTask {
  return {
    id: "task-1",
    name: "Test task",
    prompt: "Say hello",
    schedule: {
      type: "interval",
      intervalMs: 60_000,
    },
    model: "haiku",
    notify: "auto",
    maxTurns: 10,
    enabled: true,
    createdAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
  };
}

describe("CronStore", () => {
  test("supports create, list, update, and delete", async () => {
    const home = await makeTempHome();
    const store = new CronStore(home);
    const task = makeTask();

    expect(await store.listTasks()).toEqual([]);

    await store.createTask(task);
    expect(await store.listTasks()).toEqual([task]);

    const updated = await store.updateTask(task.id, (existing) => ({
      ...existing,
      name: "Updated task",
      lastResult: "CRON_OK",
      lastRunAt: new Date("2026-01-01T00:05:00.000Z").toISOString(),
    }));
    expect(updated?.name).toBe("Updated task");

    expect(await store.listTasks()).toEqual([
      {
        ...task,
        name: "Updated task",
        lastResult: "CRON_OK",
        lastRunAt: "2026-01-01T00:05:00.000Z",
      },
    ]);

    expect(await store.deleteTask(task.id)).toBe(true);
    expect(await store.listTasks()).toEqual([]);
  });

  test("treats invalid JSON store file as empty", async () => {
    const home = await makeTempHome();
    const storePath = join(home, ".xeno", "cron-tasks.json");
    await mkdir(join(home, ".xeno"), { recursive: true });
    await Bun.write(storePath, "{");

    const store = new CronStore(home);
    expect(await store.listTasks()).toEqual([]);
  });

  test("ignores malformed task entries", async () => {
    const home = await makeTempHome();
    const storePath = join(home, ".xeno", "cron-tasks.json");
    await mkdir(join(home, ".xeno"), { recursive: true });
    await writeFile(
      storePath,
      JSON.stringify({
        version: 1,
        tasks: [{ id: "bad" }, makeTask()],
      }),
      "utf-8",
    );

    const store = new CronStore(home);
    expect(await store.listTasks()).toEqual([makeTask()]);
  });

  test("supports cron_expression schedules", async () => {
    const home = await makeTempHome();
    const store = new CronStore(home);
    const task: CronTask = {
      id: "cron-expression-task",
      name: "Cron expression",
      prompt: "Say hello",
      schedule: {
        type: "cron_expression",
        cronExpression: "0 0 9 * * 1-5",
      },
      model: "haiku",
      notify: "auto",
      maxTurns: 10,
      enabled: true,
      createdAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
    };

    await store.createTask(task);
    expect(await store.listTasks()).toEqual([task]);
  });
});
