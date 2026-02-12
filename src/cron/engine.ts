import { randomUUID } from "node:crypto";
import cron, { type ScheduledTask } from "node-cron";
import { logger } from "../logger";
import { CronStore } from "./store";
import {
  CRON_DEFAULT_MAX_TURNS,
  CRON_DEFAULT_MODEL,
  CRON_DEFAULT_NOTIFY_MODE,
  isSystemCronTaskId,
  type CronSchedule,
  type CronTask,
  type CronTaskCreateInput,
  type CronTaskUpdateInput,
} from "./types";

const MAX_PENDING_TRIGGERS = 128;

export interface CronTaskExecutionResult {
  task: CronTask;
  result: string;
  durationMs: number;
  isError: boolean;
}

export interface CronQueryRequest {
  taskId: string;
  prompt: string;
  model: string;
  abortSignal: AbortSignal;
}

export interface CronQueryResult {
  result: string;
  durationMs: number;
}

type QueryRunner = (request: CronQueryRequest) => Promise<CronQueryResult>;

type CronEngineOptions = {
  home: string;
  store: CronStore;
  heartbeatTask?: CronTask;
  systemTasks?: CronTask[];
  onResult?: (result: CronTaskExecutionResult) => Promise<void> | void;
  queryRunner?: QueryRunner;
};

type TimerEntry =
  | { type: "interval"; handle: ReturnType<typeof setInterval> }
  | { type: "once"; handle: ReturnType<typeof setTimeout> };

export class CronEngine {
  private readonly home: string;
  private readonly store: CronStore;
  private readonly systemTasks: CronTask[];
  private readonly onResult:
    | ((result: CronTaskExecutionResult) => Promise<void> | void)
    | undefined;
  private readonly queryRunner: QueryRunner;
  private readonly engineLogger;

  private readonly tasks = new Map<string, CronTask>();
  private readonly timers = new Map<string, TimerEntry>();
  private readonly cronTasks = new Map<string, ScheduledTask>();
  private readonly pendingTaskIds: string[] = [];
  private readonly completionWaiters = new Map<
    string,
    Array<(result: CronTaskExecutionResult | null) => void>
  >();

  private started = false;
  private processingQueue = false;
  private activeAbortController: AbortController | null = null;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(options: CronEngineOptions) {
    this.home = options.home;
    this.store = options.store;
    this.systemTasks = this.collectSystemTasks(options);
    this.onResult = options.onResult;
    this.queryRunner = options.queryRunner ?? defaultQueryRunner;
    this.engineLogger = logger.child({ component: "cron-engine", home: this.home });
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    const persistedTasks = await this.store.listTasks();
    await this.withMutationLock(async () => {
      if (this.started) {
        return;
      }

      this.tasks.clear();
      for (const task of persistedTasks) {
        if (isSystemCronTaskId(task.id)) {
          continue;
        }
        this.tasks.set(task.id, cloneTask(task));
      }

      for (const task of this.systemTasks) {
        if (!task.enabled) {
          continue;
        }
        this.tasks.set(task.id, cloneTask(task));
      }

      this.started = true;
      for (const task of this.tasks.values()) {
        await this.scheduleTask(task);
      }
      this.engineLogger.info({ taskCount: this.tasks.size }, "Cron engine started");
    });
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }

    this.started = false;
    this.pendingTaskIds.length = 0;
    this.resolveAllCompletionWaiters(null);

    if (this.activeAbortController) {
      this.activeAbortController.abort();
      this.activeAbortController = null;
    }

    await this.withMutationLock(async () => {
      await this.destroyAllScheduledTasks();
    });
    await this.mutationQueue;
    this.engineLogger.info("Cron engine stopped");
  }

  async createTask(input: CronTaskCreateInput): Promise<CronTask> {
    return this.withMutationLock(async () => {
      const task = createTaskFromInput(input);
      this.tasks.set(task.id, cloneTask(task));
      await this.store.createTask(task);
      if (this.started) {
        await this.scheduleTask(task);
      }
      return cloneTask(task);
    });
  }

  async updateTask(id: string, updates: CronTaskUpdateInput): Promise<CronTask | null> {
    if (isSystemCronTaskId(id)) {
      throw new Error(`System task ${id} is built-in and cannot be updated.`);
    }

    return this.withMutationLock(async () => {
      const existing = this.tasks.get(id);
      if (!existing) {
        return null;
      }

      const next = applyTaskUpdates(existing, updates);
      this.tasks.set(id, cloneTask(next));
      await this.store.updateTask(id, () => cloneTask(next));

      if (this.started) {
        await this.unscheduleTask(id);
        await this.scheduleTask(next);
      }

      return cloneTask(next);
    });
  }

  async deleteTask(id: string): Promise<boolean> {
    if (isSystemCronTaskId(id)) {
      throw new Error(`System task ${id} is built-in and cannot be deleted.`);
    }

    return this.withMutationLock(async () => {
      if (!this.tasks.has(id)) {
        return false;
      }

      await this.unscheduleTask(id);
      this.tasks.delete(id);
      this.removePendingTriggers(id);
      await this.store.deleteTask(id);
      return true;
    });
  }

  listTasks(): CronTask[] {
    return [...this.tasks.values()]
      .map((task) => cloneTask(task))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async runTaskNow(taskId: string): Promise<CronTaskExecutionResult | null> {
    const task = this.tasks.get(taskId);
    if (!this.started || !task || !task.enabled) {
      return null;
    }

    return new Promise<CronTaskExecutionResult | null>((resolve) => {
      const existing = this.completionWaiters.get(taskId) ?? [];
      existing.push(resolve);
      this.completionWaiters.set(taskId, existing);
      this.enqueueTaskTrigger(taskId);
    });
  }

  private async scheduleTask(task: CronTask): Promise<void> {
    if (!this.started || !task.enabled) {
      return;
    }

    if (task.schedule.type === "interval") {
      const intervalMs = Math.max(task.schedule.intervalMs, 1);
      const handle = setInterval(() => {
        this.enqueueTaskTrigger(task.id);
      }, intervalMs);
      this.timers.set(task.id, { type: "interval", handle });
      return;
    }

    if (task.schedule.type === "once") {
      const runAtMs = Date.parse(task.schedule.runAt);
      if (!Number.isFinite(runAtMs)) {
        this.engineLogger.warn(
          { taskId: task.id, runAt: task.schedule.runAt },
          "Invalid runAt for cron task",
        );
        return;
      }

      if (runAtMs <= Date.now()) {
        queueMicrotask(() => {
          this.enqueueTaskTrigger(task.id);
        });
        return;
      }

      const delayMs = Math.max(0, runAtMs - Date.now());
      const handle = setTimeout(() => {
        this.timers.delete(task.id);
        this.enqueueTaskTrigger(task.id);
      }, delayMs);
      this.timers.set(task.id, { type: "once", handle });
      return;
    }

    if (task.schedule.type !== "cron_expression") {
      return;
    }

    const expression = task.schedule.cronExpression;
    if (!cron.validate(expression)) {
      this.engineLogger.warn(
        {
          taskId: task.id,
          expression,
        },
        "Invalid cron expression for task",
      );
      return;
    }

    const scheduledTask = cron.createTask(
      expression,
      () => {
        this.enqueueTaskTrigger(task.id);
      },
      {
        name: task.name,
        noOverlap: true,
      },
    );
    await this.activateCronTask(task.id, scheduledTask);
  }

  private async unscheduleTask(taskId: string): Promise<void> {
    const timer = this.timers.get(taskId);
    if (timer) {
      this.clearTimerEntry(timer);
      this.timers.delete(taskId);
    }

    const scheduledTask = this.cronTasks.get(taskId);
    this.cronTasks.delete(taskId);

    if (!scheduledTask) {
      return;
    }

    try {
      await Promise.resolve(scheduledTask.destroy());
    } catch (error) {
      this.engineLogger.error({ error, taskId }, "Failed to destroy cron task");
    }
  }

  private async destroyAllScheduledTasks(): Promise<void> {
    for (const timer of this.timers.values()) {
      this.clearTimerEntry(timer);
    }
    this.timers.clear();

    const entries = [...this.cronTasks.entries()];
    this.cronTasks.clear();

    await Promise.all(
      entries.map(async ([taskId, task]) => {
        try {
          await Promise.resolve(task.destroy());
        } catch (error) {
          this.engineLogger.error({ error, taskId }, "Failed to destroy cron task");
        }
      }),
    );
  }

  private async activateCronTask(taskId: string, task: ScheduledTask): Promise<void> {
    this.cronTasks.set(taskId, task);
    try {
      await Promise.resolve(task.start());
    } catch (error) {
      this.cronTasks.delete(taskId);
      this.engineLogger.error({ error, taskId }, "Failed to start cron task");
    }
  }

  private clearTimerEntry(entry: TimerEntry): void {
    if (entry.type === "interval") {
      clearInterval(entry.handle);
      return;
    }
    clearTimeout(entry.handle);
  }

  private enqueueTaskTrigger(taskId: string): void {
    if (!this.started) {
      return;
    }

    if (this.pendingTaskIds.length >= MAX_PENDING_TRIGGERS) {
      this.engineLogger.warn({ taskId }, "Cron trigger dropped due to queue overflow");
      return;
    }

    this.pendingTaskIds.push(taskId);
    void this.processQueue();
  }

  private async processQueue(): Promise<void> {
    if (this.processingQueue || !this.started) {
      return;
    }

    this.processingQueue = true;
    try {
      while (this.started && this.pendingTaskIds.length > 0) {
        const taskId = this.pendingTaskIds.shift();
        if (!taskId) {
          continue;
        }
        try {
          await this.executeTask(taskId);
        } catch (error) {
          this.engineLogger.error({ error, taskId }, "Cron task execution failed");
        }
      }
    } finally {
      this.processingQueue = false;
    }
  }

  private async executeTask(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task || !task.enabled) {
      this.resolveCompletionWaiters(taskId, null);
      return;
    }

    let durationMs = 0;
    let result = "";
    let isError = false;
    const startedAt = Date.now();
    const abortController = new AbortController();
    this.activeAbortController = abortController;

    try {
      const runResult = await this.queryRunner({
        taskId: task.id,
        prompt: task.prompt,
        model: CRON_DEFAULT_MODEL,
        abortSignal: abortController.signal,
      });
      result = runResult.result;
      durationMs = runResult.durationMs;
    } catch (error) {
      isError = true;
      durationMs = Date.now() - startedAt;
      const message = error instanceof Error ? error.message : String(error);
      result = `Error: ${message}`;
    } finally {
      if (this.activeAbortController === abortController) {
        this.activeAbortController = null;
      }
    }

    const completedAt = new Date().toISOString();
    const shouldDisableAfterRun = task.schedule.type === "once";
    const updatedTask = await this.withMutationLock(async () => {
      const latest = this.tasks.get(taskId);
      if (!latest) {
        return null;
      }

      const next: CronTask = {
        ...latest,
        lastRunAt: completedAt,
        lastResult: result,
        enabled: shouldDisableAfterRun ? false : latest.enabled,
      };

      this.tasks.set(taskId, cloneTask(next));
      if (isPersistentTask(taskId)) {
        await this.store.updateTask(taskId, () => cloneTask(next));
      }
      if (shouldDisableAfterRun) {
        await this.unscheduleTask(taskId);
      }
      return cloneTask(next);
    });

    if (!updatedTask) {
      this.resolveCompletionWaiters(taskId, null);
      return;
    }

    const payload: CronTaskExecutionResult = {
      task: updatedTask,
      result,
      durationMs,
      isError,
    };

    this.engineLogger.info(
      {
        taskId: updatedTask.id,
        taskName: updatedTask.name,
        durationMs,
      },
      "Cron task finished",
    );

    if (this.onResult) {
      try {
        await this.onResult(payload);
      } catch (error) {
        this.engineLogger.error({ error, taskId: updatedTask.id }, "Cron onResult callback failed");
      }
    }

    this.resolveCompletionWaiters(updatedTask.id, payload);
  }

  private removePendingTriggers(taskId: string): void {
    let writeIndex = 0;
    for (let index = 0; index < this.pendingTaskIds.length; index += 1) {
      const current = this.pendingTaskIds[index];
      if (current !== undefined && current !== taskId) {
        this.pendingTaskIds[writeIndex] = current;
        writeIndex += 1;
      }
    }
    this.pendingTaskIds.length = writeIndex;
  }

  private async withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationQueue.then(operation);
    this.mutationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private resolveCompletionWaiters(taskId: string, result: CronTaskExecutionResult | null): void {
    const waiters = this.completionWaiters.get(taskId);
    if (!waiters || waiters.length === 0) {
      return;
    }
    this.completionWaiters.delete(taskId);
    for (const waiter of waiters) {
      waiter(result);
    }
  }

  private resolveAllCompletionWaiters(result: CronTaskExecutionResult | null): void {
    const entries = [...this.completionWaiters.entries()];
    this.completionWaiters.clear();
    for (const [, waiters] of entries) {
      for (const waiter of waiters) {
        waiter(result);
      }
    }
  }

  private collectSystemTasks(options: CronEngineOptions): CronTask[] {
    const tasksById = new Map<string, CronTask>();
    if (options.heartbeatTask) {
      tasksById.set(options.heartbeatTask.id, cloneTask(options.heartbeatTask));
    }

    for (const task of options.systemTasks ?? []) {
      tasksById.set(task.id, cloneTask(task));
    }

    return [...tasksById.values()];
  }
}

function isPersistentTask(taskId: string): boolean {
  return !isSystemCronTaskId(taskId);
}

function createTaskFromInput(input: CronTaskCreateInput): CronTask {
  const name = requireTrimmed(input.name, "name");
  const prompt = requireTrimmed(input.prompt, "prompt");
  const schedule = normalizeSchedule(input.schedule);
  const maxTurns = normalizePositiveInteger(input.maxTurns, "maxTurns") ?? CRON_DEFAULT_MAX_TURNS;
  const notify = input.notify ?? CRON_DEFAULT_NOTIFY_MODE;
  validateNotifyMode(notify);

  return {
    id: randomUUID(),
    name,
    prompt,
    schedule,
    notify,
    maxTurns,
    enabled: input.enabled ?? true,
    createdAt: new Date().toISOString(),
  };
}

function applyTaskUpdates(task: CronTask, updates: CronTaskUpdateInput): CronTask {
  const next: CronTask = cloneTask(task);

  if (updates.name !== undefined) {
    next.name = requireTrimmed(updates.name, "name");
  }
  if (updates.prompt !== undefined) {
    next.prompt = requireTrimmed(updates.prompt, "prompt");
  }
  if (updates.schedule !== undefined) {
    next.schedule = normalizeSchedule(updates.schedule);
  }
  if (updates.notify !== undefined) {
    validateNotifyMode(updates.notify);
    next.notify = updates.notify;
  }
  if (updates.maxTurns !== undefined) {
    next.maxTurns =
      updates.maxTurns === null
        ? undefined
        : normalizePositiveInteger(updates.maxTurns, "maxTurns");
  }
  if (updates.enabled !== undefined) {
    next.enabled = updates.enabled;
  }

  return next;
}

function cloneTask(task: CronTask): CronTask {
  return {
    ...task,
    schedule: cloneSchedule(task.schedule),
  };
}

function normalizeSchedule(schedule: CronSchedule): CronSchedule {
  if (schedule.type === "interval") {
    const intervalMs = normalizePositiveInteger(schedule.intervalMs, "schedule.intervalMs");
    if (!intervalMs) {
      throw new Error("schedule.intervalMs must be a positive integer.");
    }
    return { type: "interval", intervalMs };
  }

  if (schedule.type === "once") {
    const runAt = requireTrimmed(schedule.runAt, "schedule.runAt");
    const runAtMs = Date.parse(runAt);
    if (!Number.isFinite(runAtMs)) {
      throw new Error("schedule.runAt must be a valid date string.");
    }
    return { type: "once", runAt: new Date(runAtMs).toISOString() };
  }

  if (schedule.type === "cron_expression") {
    const cronExpression = requireTrimmed(schedule.cronExpression, "schedule.cronExpression");
    if (!cron.validate(cronExpression)) {
      throw new Error("schedule.cronExpression must be a valid cron expression.");
    }
    return { type: "cron_expression", cronExpression };
  }

  throw new Error("Unsupported schedule type.");
}

function requireTrimmed(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return trimmed;
}

function normalizePositiveInteger(value: number | undefined, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer.`);
  }
  return value;
}

function validateNotifyMode(mode: CronTask["notify"]): void {
  if (mode === "auto" || mode === "never") {
    return;
  }
  throw new Error(`Invalid notify mode: ${String(mode)}`);
}

function stripCodeFence(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("```") || !trimmed.endsWith("```")) {
    return trimmed;
  }

  const lines = trimmed.split("\n");
  if (lines.length < 2) {
    return trimmed;
  }
  return lines.slice(1, -1).join("\n").trim();
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

async function defaultQueryRunner(): Promise<CronQueryResult> {
  throw new Error("Cron query runner is not configured.");
}
