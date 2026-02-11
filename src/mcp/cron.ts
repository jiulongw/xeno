import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import type { CronTask, CronTaskUpdateInput } from "../cron/types";
import { CronEngine } from "../cron/engine";

export function createCronMcpServer(engine: CronEngine) {
  return createSdkMcpServer({
    name: "xeno-cron",
    version: "1.0.0",
    tools: [
      tool(
        "create_cron_task",
        "Create a recurring cron task with interval_minutes or cron_expression, or a one-shot task with run_at.",
        {
          name: z.string().min(1),
          prompt: z.string().min(1),
          interval_minutes: z.number().positive().optional(),
          run_at: z.string().min(1).optional(),
          cron_expression: z.string().min(1).optional(),
          notify: z.enum(["auto", "never"]).optional(),
          max_turns: z.number().int().positive().optional(),
          enabled: z.boolean().optional(),
        },
        async (args) => {
          const schedule = parseSchedule(args.interval_minutes, args.run_at, args.cron_expression);
          if (!schedule) {
            throw new Error(
              "Missing schedule. Provide interval_minutes, run_at, or cron_expression.",
            );
          }
          const task = await engine.createTask({
            name: args.name,
            prompt: args.prompt,
            schedule,
            notify: args.notify,
            maxTurns: args.max_turns,
            enabled: args.enabled,
          });
          return successResult(`Created cron task ${task.id}.`, { task: toTaskSummary(task) });
        },
      ),
      tool(
        "list_cron_tasks",
        "List all cron tasks including schedule, status, and last run details.",
        {},
        async () => {
          const tasks = engine.listTasks().map(toTaskSummary);
          return successResult(`Found ${tasks.length} cron task(s).`, { tasks });
        },
      ),
      tool(
        "delete_cron_task",
        "Delete a cron task by ID.",
        {
          id: z.string().min(1),
        },
        async (args) => {
          const removed = await engine.deleteTask(args.id);
          if (!removed) {
            return successResult(`Cron task ${args.id} was not found.`, { removed: false });
          }
          return successResult(`Deleted cron task ${args.id}.`, { removed: true });
        },
      ),
      tool(
        "update_cron_task",
        "Update cron task fields like schedule, prompt, and enabled status.",
        {
          id: z.string().min(1),
          name: z.string().min(1).optional(),
          prompt: z.string().min(1).optional(),
          interval_minutes: z.number().positive().optional(),
          run_at: z.string().min(1).optional(),
          cron_expression: z.string().min(1).optional(),
          notify: z.enum(["auto", "never"]).optional(),
          max_turns: z.union([z.number().int().positive(), z.null()]).optional(),
          enabled: z.boolean().optional(),
        },
        async (args) => {
          const updates: CronTaskUpdateInput = {};
          if (args.name !== undefined) {
            updates.name = args.name;
          }
          if (args.prompt !== undefined) {
            updates.prompt = args.prompt;
          }
          if (args.notify !== undefined) {
            updates.notify = args.notify;
          }
          if (args.max_turns !== undefined) {
            updates.maxTurns = args.max_turns;
          }
          if (args.enabled !== undefined) {
            updates.enabled = args.enabled;
          }
          const schedule = parseSchedule(args.interval_minutes, args.run_at, args.cron_expression, {
            allowOmitted: true,
          });
          if (schedule) {
            updates.schedule = schedule;
          }

          const task = await engine.updateTask(args.id, updates);
          if (!task) {
            return successResult(`Cron task ${args.id} was not found.`, { updated: false });
          }
          return successResult(`Updated cron task ${args.id}.`, {
            updated: true,
            task: toTaskSummary(task),
          });
        },
      ),
    ],
  });
}

function parseSchedule(
  intervalMinutes: number | undefined,
  runAtRaw: string | undefined,
  cronExpressionRaw: string | undefined,
  options?: { allowOmitted?: boolean },
): CronTask["schedule"] | null {
  const hasInterval = intervalMinutes !== undefined;
  const hasRunAt = runAtRaw !== undefined;
  const hasCronExpression = cronExpressionRaw !== undefined;

  const selectedCount = Number(hasInterval) + Number(hasRunAt) + Number(hasCronExpression);
  if (selectedCount > 1) {
    throw new Error("Provide only one schedule: interval_minutes, run_at, or cron_expression.");
  }
  if (!hasInterval && !hasRunAt && !hasCronExpression) {
    if (options?.allowOmitted) {
      return null;
    }
    throw new Error("Missing schedule. Provide interval_minutes, run_at, or cron_expression.");
  }

  if (hasInterval) {
    return {
      type: "interval",
      intervalMs: Math.round(intervalMinutes! * 60_000),
    };
  }

  if (hasCronExpression) {
    const cronExpression = cronExpressionRaw!.trim();
    if (!cronExpression) {
      throw new Error("cron_expression must be a non-empty string.");
    }
    return {
      type: "cron_expression",
      cronExpression,
    };
  }

  const runAt = new Date(runAtRaw!);
  if (!Number.isFinite(runAt.getTime())) {
    throw new Error("run_at must be a valid datetime string.");
  }
  return {
    type: "once",
    runAt: runAt.toISOString(),
  };
}

function toTaskSummary(task: CronTask) {
  return {
    id: task.id,
    name: task.name,
    enabled: task.enabled,
    notify: task.notify,
    maxTurns: task.maxTurns ?? 10,
    schedule:
      task.schedule.type === "interval"
        ? {
            type: "interval",
            interval_minutes: task.schedule.intervalMs / 60_000,
          }
        : task.schedule.type === "once"
          ? {
              type: "once",
              run_at: task.schedule.runAt,
            }
          : {
              type: "cron_expression",
              cron_expression: task.schedule.cronExpression,
            },
    createdAt: task.createdAt,
    lastRunAt: task.lastRunAt ?? null,
    lastResult: task.lastResult ?? null,
  };
}

function successResult(text: string, structuredContent?: Record<string, unknown>) {
  return {
    content: [
      {
        type: "text" as const,
        text,
      },
    ],
    structuredContent,
  };
}
