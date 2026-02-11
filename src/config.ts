import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface AppConfig {
  defaultHome?: string;
  telegramBotToken?: string;
  telegramAllowedUsers?: string[];
  heartbeatIntervalMinutes?: number;
  heartbeatModel?: string;
  heartbeatEnabled?: boolean;
}

export function getConfigPath(baseHome: string = homedir()): string {
  return join(baseHome, ".config", "xeno", "config.json");
}

export async function loadConfigFromPath(configPath: string): Promise<AppConfig> {
  if (!existsSync(configPath)) {
    return {};
  }

  let raw = "";
  try {
    raw = await readFile(configPath, "utf-8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read config file at ${configPath}: ${message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in config file at ${configPath}: ${message}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Config file at ${configPath} must contain a JSON object.`);
  }

  const record = parsed as Record<string, unknown>;
  const defaultHome = readOptionalString(record, "default_home", configPath);
  const telegramBotToken = readOptionalString(record, "telegram_bot_token", configPath);
  const telegramAllowedUsers = readOptionalTelegramUserIdList(
    record,
    "telegram_allowed_users",
    configPath,
  );
  const heartbeatIntervalMinutes = readOptionalNumber(
    record,
    "heartbeat_interval_minutes",
    configPath,
  );
  const heartbeatModel = readOptionalString(record, "heartbeat_model", configPath);
  const heartbeatEnabled = readOptionalBoolean(record, "heartbeat_enabled", configPath);

  return {
    defaultHome: defaultHome?.trim() || undefined,
    telegramBotToken: telegramBotToken?.trim() || undefined,
    telegramAllowedUsers,
    heartbeatIntervalMinutes,
    heartbeatModel: heartbeatModel?.trim() || undefined,
    heartbeatEnabled,
  };
}

export async function loadUserConfig(): Promise<AppConfig> {
  return loadConfigFromPath(getConfigPath());
}

export function resolveHome(
  cliHome: string | undefined,
  config: AppConfig,
  configPath: string = getConfigPath(),
  cwd: string = process.cwd(),
): string {
  const home = cliHome?.trim() || config.defaultHome?.trim();
  if (!home) {
    throw new Error(`Missing home. Pass --home <path> or set default_home in ${configPath}.`);
  }

  return resolve(cwd, expandHomeShortcut(home));
}

export function resolveTelegramBotToken(
  config: AppConfig,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const envToken = env.TELEGRAM_BOT_TOKEN?.trim();
  if (envToken) {
    return envToken;
  }
  return config.telegramBotToken;
}

function readOptionalString(
  source: Record<string, unknown>,
  key: string,
  configPath: string,
): string | undefined {
  const value = source[key];
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error(`Expected "${key}" in ${configPath} to be a string.`);
  }

  return value;
}

function readOptionalNumber(
  source: Record<string, unknown>,
  key: string,
  configPath: string,
): number | undefined {
  const value = source[key];
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Expected "${key}" in ${configPath} to be a number.`);
  }

  return value;
}

function readOptionalBoolean(
  source: Record<string, unknown>,
  key: string,
  configPath: string,
): boolean | undefined {
  const value = source[key];
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    throw new Error(`Expected "${key}" in ${configPath} to be a boolean.`);
  }

  return value;
}

function readOptionalTelegramUserIdList(
  source: Record<string, unknown>,
  key: string,
  configPath: string,
): string[] | undefined {
  const value = source[key];
  if (value === undefined || value === null) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new Error(`Expected "${key}" in ${configPath} to be an array.`);
  }

  const normalized: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      const trimmed = entry.trim();
      if (!trimmed) {
        throw new Error(`Expected all entries in "${key}" in ${configPath} to be non-empty.`);
      }
      normalized.push(trimmed);
      continue;
    }

    if (typeof entry === "number" && Number.isFinite(entry) && Number.isInteger(entry)) {
      normalized.push(String(entry));
      continue;
    }

    throw new Error(`Expected all entries in "${key}" in ${configPath} to be strings or integers.`);
  }

  return Array.from(new Set(normalized));
}

function expandHomeShortcut(pathValue: string, baseHome: string = homedir()): string {
  if (pathValue === "~") {
    return baseHome;
  }

  if (pathValue.startsWith("~/")) {
    return join(baseHome, pathValue.slice(2));
  }

  return pathValue;
}
