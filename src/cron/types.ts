export type CronSchedule =
  | { type: "interval"; intervalMs: number }
  | { type: "once"; runAt: string }
  | { type: "cron_expression"; cronExpression: string };

export type CronNotifyMode = "auto" | "never";

export interface CronTask {
  id: string;
  name: string;
  prompt: string;
  schedule: CronSchedule;
  notify: CronNotifyMode;
  maxTurns?: number;
  enabled: boolean;
  createdAt: string;
  lastRunAt?: string;
  lastResult?: string;
}

export interface CronTaskCreateInput {
  name: string;
  prompt: string;
  schedule: CronSchedule;
  notify?: CronNotifyMode;
  maxTurns?: number;
  enabled?: boolean;
}

export interface CronTaskUpdateInput {
  name?: string;
  prompt?: string;
  schedule?: CronSchedule;
  notify?: CronNotifyMode;
  maxTurns?: number | null;
  enabled?: boolean;
}

export const CRON_DEFAULT_MODEL = "haiku";
export const CRON_DEFAULT_NOTIFY_MODE: CronNotifyMode = "auto";
export const CRON_DEFAULT_MAX_TURNS = 10;

export const HEARTBEAT_TASK_ID = "__heartbeat__";
export const WEEKLY_NEW_SESSION_TASK_ID = "__weekly_new_session__";

const SYSTEM_CRON_TASK_IDS = new Set<string>([HEARTBEAT_TASK_ID, WEEKLY_NEW_SESSION_TASK_ID]);

export function isSystemCronTaskId(taskId: string): boolean {
  return SYSTEM_CRON_TASK_IDS.has(taskId);
}
