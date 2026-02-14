import {
  CRON_DEFAULT_MAX_TURNS,
  CRON_DEFAULT_NOTIFY_MODE,
  WEEKLY_NEW_SESSION_TASK_ID,
  type CronTask,
} from "./types";

export const WEEKLY_NEW_SESSION_CRON_EXPRESSION = "0 0 0 * * 1";

export function createWeeklyNewSessionTask(): CronTask {
  return {
    id: WEEKLY_NEW_SESSION_TASK_ID,
    name: "weekly-new-session",
    prompt: "Wake up and bring back your memory.",
    schedule: {
      type: "cron_expression",
      cronExpression: WEEKLY_NEW_SESSION_CRON_EXPRESSION,
    },
    notify: CRON_DEFAULT_NOTIFY_MODE,
    maxTurns: CRON_DEFAULT_MAX_TURNS,
    enabled: true,
    createdAt: new Date().toISOString(),
  };
}
