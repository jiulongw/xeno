import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  CronEngine,
  type CronQueryRequest,
  type CronTaskExecutionResult,
} from "../../src/cron/engine";
import { createHeartbeatTask } from "../../src/cron/heartbeat";
import { CronStore } from "../../src/cron/store";
import { HEARTBEAT_TASK_ID } from "../../src/cron/types";

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
  const dir = await mkdtemp(join(tmpdir(), "xeno-cron-engine-test-"));
  tempDirs.push(dir);
  return dir;
}

describe("CronEngine", () => {
  test("runs one-shot tasks, persists result, and disables task after execution", async () => {
    const home = await makeTempHome();
    const store = new CronStore(home);
    await store.createTask({
      id: "once-task",
      name: "One-shot",
      prompt: "Ping",
      schedule: {
        type: "once",
        runAt: new Date(Date.now() + 2_000).toISOString(),
      },
      model: "haiku",
      notify: "auto",
      maxTurns: 10,
      enabled: true,
      createdAt: new Date().toISOString(),
    });

    const events: CronTaskExecutionResult[] = [];
    const queryCalls: CronQueryRequest[] = [];
    const engine = new CronEngine({
      home,
      store,
      queryRunner: async (options) => {
        queryCalls.push(options);
        return { result: "CRON_OK", durationMs: 1 };
      },
      onResult: (result) => {
        events.push(result);
      },
    });

    await engine.start();
    await sleep(3_500);
    await engine.stop();

    expect(queryCalls.length).toBe(1);
    expect(events.length).toBe(1);

    const runtimeTask = engine.listTasks().find((task) => task.id === "once-task");
    expect(runtimeTask?.enabled).toBe(false);
    expect(runtimeTask?.lastResult).toBe("CRON_OK");
    expect(typeof runtimeTask?.lastRunAt).toBe("string");

    const persistedTask = (await store.listTasks()).find((task) => task.id === "once-task");
    expect(persistedTask?.enabled).toBe(false);
    expect(persistedTask?.lastResult).toBe("CRON_OK");
  });

  test("includes heartbeat as an in-memory built-in task only", async () => {
    const home = await makeTempHome();
    const store = new CronStore(home);
    const engine = new CronEngine({
      home,
      store,
      heartbeatTask: createHeartbeatTask({
        intervalMinutes: 60,
        enabled: true,
      }),
      queryRunner: async () => ({ result: "HEARTBEAT_OK", durationMs: 1 }),
    });

    await engine.start();
    const tasks = engine.listTasks();
    await engine.stop();

    expect(tasks.some((task) => task.id === HEARTBEAT_TASK_ID)).toBe(true);
    expect(await store.listTasks()).toEqual([]);
  });

  test("runs cron_expression tasks via node-cron", async () => {
    const home = await makeTempHome();
    const store = new CronStore(home);
    await store.createTask({
      id: "cron-task",
      name: "Cron expression",
      prompt: "Ping",
      schedule: {
        type: "cron_expression",
        cronExpression: "* * * * * *",
      },
      model: "haiku",
      notify: "auto",
      maxTurns: 10,
      enabled: true,
      createdAt: new Date().toISOString(),
    });

    let queryCount = 0;
    const engine = new CronEngine({
      home,
      store,
      queryRunner: async () => {
        queryCount += 1;
        return { result: "CRON_OK", durationMs: 1 };
      },
    });

    await engine.start();
    await sleep(2_200);
    await engine.stop();

    expect(queryCount).toBeGreaterThanOrEqual(1);
  });

  test("supports create, update, and delete through engine methods", async () => {
    const home = await makeTempHome();
    const store = new CronStore(home);
    const engine = new CronEngine({
      home,
      store,
      queryRunner: async () => ({ result: "CRON_OK", durationMs: 1 }),
    });

    await engine.start();

    const created = await engine.createTask({
      name: "Recurring",
      prompt: "Check status",
      schedule: {
        type: "interval",
        intervalMs: 60_000,
      },
    });
    expect(created.name).toBe("Recurring");

    const updated = await engine.updateTask(created.id, {
      enabled: false,
      notify: "auto",
      model: null,
    });
    expect(updated?.enabled).toBe(false);
    expect(updated?.notify).toBe("auto");
    expect(updated?.model).toBeUndefined();

    const removed = await engine.deleteTask(created.id);
    expect(removed).toBe(true);
    expect(engine.listTasks().some((task) => task.id === created.id)).toBe(false);

    await engine.stop();
  });

  test("runTaskNow executes heartbeat immediately and returns outcome", async () => {
    const home = await makeTempHome();
    const store = new CronStore(home);
    const engine = new CronEngine({
      home,
      store,
      heartbeatTask: createHeartbeatTask({
        intervalMinutes: 60,
        enabled: true,
      }),
      queryRunner: async () => ({ result: "HEARTBEAT_OK", durationMs: 7 }),
    });

    await engine.start();
    const outcome = await engine.runTaskNow(HEARTBEAT_TASK_ID);
    await engine.stop();

    expect(outcome).not.toBeNull();
    expect(outcome?.task.id).toBe(HEARTBEAT_TASK_ID);
    expect(outcome?.result).toBe("HEARTBEAT_OK");
  });
});
