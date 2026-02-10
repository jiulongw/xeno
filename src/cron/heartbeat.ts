import {
  CRON_DEFAULT_MAX_TURNS,
  CRON_DEFAULT_MODEL,
  CRON_DEFAULT_NOTIFY_MODE,
  HEARTBEAT_SENTINEL_OK,
  HEARTBEAT_TASK_ID,
  type CronTask,
} from "./types";

export const DEFAULT_HEARTBEAT_INTERVAL_MINUTES = 30;

export function createHeartbeatTask(options?: {
  intervalMinutes?: number;
  model?: string;
  enabled?: boolean;
}): CronTask {
  const intervalMinutes = options?.intervalMinutes ?? DEFAULT_HEARTBEAT_INTERVAL_MINUTES;
  const model = options?.model?.trim() || CRON_DEFAULT_MODEL;

  return {
    id: HEARTBEAT_TASK_ID,
    name: "heartbeat",
    prompt:
      `Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. ` +
      `Do not infer or repeat old tasks from prior chats. ` +
      `If nothing needs attention, reply ${HEARTBEAT_SENTINEL_OK}.`,
    schedule: {
      type: "interval",
      intervalMs: Math.max(1, intervalMinutes) * 60_000,
    },
    model,
    notify: CRON_DEFAULT_NOTIFY_MODE,
    maxTurns: CRON_DEFAULT_MAX_TURNS,
    enabled: options?.enabled ?? true,
    createdAt: new Date().toISOString(),
  };
}
