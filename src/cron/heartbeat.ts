import {
  CRON_DEFAULT_MAX_TURNS,
  CRON_DEFAULT_NOTIFY_MODE,
  HEARTBEAT_TASK_ID,
  type CronTask,
} from "./types";

export const DEFAULT_HEARTBEAT_INTERVAL_MINUTES = 30;

export function createHeartbeatTask(options?: {
  intervalMinutes?: number;
  enabled?: boolean;
}): CronTask {
  const intervalMinutes = options?.intervalMinutes ?? DEFAULT_HEARTBEAT_INTERVAL_MINUTES;

  return {
    id: HEARTBEAT_TASK_ID,
    name: "heartbeat",
    prompt: "",
    schedule: {
      type: "interval",
      intervalMs: Math.max(1, intervalMinutes) * 60_000,
    },
    notify: CRON_DEFAULT_NOTIFY_MODE,
    maxTurns: CRON_DEFAULT_MAX_TURNS,
    enabled: options?.enabled ?? true,
    createdAt: new Date().toISOString(),
  };
}
