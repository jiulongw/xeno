import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { logger } from "../logger";
import type { CronSchedule, CronTask } from "./types";

type CronStoreFile = {
  version: 1;
  tasks: CronTask[];
};

const CRON_STORE_VERSION = 1;

export class CronStore {
  readonly filePath: string;
  private readonly storeLogger;

  constructor(home: string) {
    this.filePath = join(home, ".xeno", "cron-tasks.json");
    this.storeLogger = logger.child({ component: "cron-store", filePath: this.filePath });
  }

  async listTasks(): Promise<CronTask[]> {
    const file = await this.readStoreFile();
    return file.tasks.map((task) => cloneCronTask(task));
  }

  async createTask(task: CronTask): Promise<void> {
    const file = await this.readStoreFile();
    file.tasks.push(cloneCronTask(task));
    await this.writeStoreFile(file);
  }

  async updateTask(id: string, updater: (task: CronTask) => CronTask): Promise<CronTask | null> {
    const file = await this.readStoreFile();
    const index = file.tasks.findIndex((task) => task.id === id);
    if (index === -1) {
      return null;
    }

    const next = updater(cloneCronTask(file.tasks[index]!));
    file.tasks[index] = cloneCronTask(next);
    await this.writeStoreFile(file);
    return cloneCronTask(next);
  }

  async deleteTask(id: string): Promise<boolean> {
    const file = await this.readStoreFile();
    const countBefore = file.tasks.length;
    file.tasks = file.tasks.filter((task) => task.id !== id);
    if (file.tasks.length === countBefore) {
      return false;
    }

    await this.writeStoreFile(file);
    return true;
  }

  private async readStoreFile(): Promise<CronStoreFile> {
    let raw = "";
    try {
      raw = await readFile(this.filePath, "utf-8");
    } catch (error) {
      if (isNotFoundError(error)) {
        return emptyStoreFile();
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      this.storeLogger.warn({ error }, "Invalid cron store JSON; treating as empty");
      return emptyStoreFile();
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      this.storeLogger.warn("Cron store root is invalid; treating as empty");
      return emptyStoreFile();
    }

    const record = parsed as Record<string, unknown>;
    const rawTasks = record.tasks;
    if (!Array.isArray(rawTasks)) {
      this.storeLogger.warn("Cron store missing tasks array; treating as empty");
      return emptyStoreFile();
    }

    const tasks: CronTask[] = [];
    for (const entry of rawTasks) {
      const parsedTask = parseCronTask(entry);
      if (!parsedTask) {
        continue;
      }
      tasks.push(parsedTask);
    }

    return {
      version: CRON_STORE_VERSION,
      tasks,
    };
  }

  private async writeStoreFile(file: CronStoreFile): Promise<void> {
    const normalized: CronStoreFile = {
      version: CRON_STORE_VERSION,
      tasks: file.tasks.map((task) => cloneCronTask(task)),
    };

    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf-8");
    await rename(tempPath, this.filePath);
  }
}

function cloneCronTask(task: CronTask): CronTask {
  return {
    ...task,
    schedule: cloneSchedule(task.schedule),
  };
}

function emptyStoreFile(): CronStoreFile {
  return {
    version: CRON_STORE_VERSION,
    tasks: [],
  };
}

function parseCronTask(value: unknown): CronTask | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const id = asNonEmptyString(record.id);
  const name = asNonEmptyString(record.name);
  const prompt = asNonEmptyString(record.prompt);
  const createdAt = asNonEmptyString(record.createdAt);
  const schedule = parseCronSchedule(record.schedule);
  const notify = parseNotifyMode(record.notify);
  const enabled = record.enabled;

  if (
    !id ||
    !name ||
    !prompt ||
    !createdAt ||
    !schedule ||
    !notify ||
    typeof enabled !== "boolean"
  ) {
    return null;
  }

  const model = asOptionalNonEmptyString(record.model);
  const lastRunAt = asOptionalNonEmptyString(record.lastRunAt);
  const lastResult = asOptionalString(record.lastResult);
  const maxTurns = asOptionalPositiveInteger(record.maxTurns);

  return {
    id,
    name,
    prompt,
    schedule,
    model,
    notify,
    maxTurns,
    enabled,
    createdAt,
    lastRunAt,
    lastResult,
  };
}

function parseCronSchedule(value: unknown): CronSchedule | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (record.type === "interval") {
    const intervalMs = asOptionalPositiveInteger(record.intervalMs);
    if (!intervalMs) {
      return null;
    }
    return { type: "interval", intervalMs };
  }

  if (record.type === "once") {
    const runAt = asNonEmptyString(record.runAt);
    if (!runAt) {
      return null;
    }
    return { type: "once", runAt };
  }

  if (record.type === "cron_expression") {
    const cronExpression = asNonEmptyString(record.cronExpression);
    if (!cronExpression) {
      return null;
    }
    return { type: "cron_expression", cronExpression };
  }

  return null;
}

function cloneSchedule(schedule: CronSchedule): CronSchedule {
  if (schedule.type === "interval") {
    return { type: "interval", intervalMs: schedule.intervalMs };
  }
  if (schedule.type === "once") {
    return { type: "once", runAt: schedule.runAt };
  }
  return { type: "cron_expression", cronExpression: schedule.cronExpression };
}

function parseNotifyMode(value: unknown): CronTask["notify"] | null {
  if (value === "auto" || value === "always" || value === "never") {
    return value;
  }
  return null;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed;
}

function asOptionalString(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return typeof value === "string" ? value : undefined;
}

function asOptionalNonEmptyString(value: unknown): string | undefined {
  const parsed = asNonEmptyString(value);
  return parsed ?? undefined;
}

function asOptionalPositiveInteger(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function isNotFoundError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
