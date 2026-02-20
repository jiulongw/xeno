import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type TelegramAllowedUsers = Record<string, string[]>;

export interface AppConfig {
  defaultHome?: string;
  telegramBotToken?: string;
  telegramAllowedUsers?: TelegramAllowedUsers;
  heartbeatIntervalMinutes?: number;
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
  const telegramAllowedUsers = readTelegramAllowedUsers(
    record,
    "telegram_allowed_users",
    configPath,
  );
  const heartbeatIntervalMinutes = readOptionalNumber(
    record,
    "heartbeat_interval_minutes",
    configPath,
  );
  const heartbeatEnabled = readOptionalBoolean(record, "heartbeat_enabled", configPath);

  return {
    defaultHome: defaultHome?.trim() || undefined,
    telegramBotToken: telegramBotToken?.trim() || undefined,
    telegramAllowedUsers,
    heartbeatIntervalMinutes,
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

function readTelegramAllowedUsers(
  source: Record<string, unknown>,
  key: string,
  configPath: string,
): TelegramAllowedUsers | undefined {
  const value = source[key];
  if (value === undefined || value === null) {
    return undefined;
  }

  // Legacy array format: ["123", "456"] → { "123": ["*"], "456": ["*"] }
  if (Array.isArray(value)) {
    const result: TelegramAllowedUsers = {};
    for (const entry of value) {
      const userId = normalizeUserId(entry, key, configPath);
      result[userId] = ["*"];
    }
    return result;
  }

  // New object format: { "123": ["*"], "456": ["-1001234567890"] }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const result: TelegramAllowedUsers = {};
    for (const [userId, channels] of Object.entries(record)) {
      const trimmedId = userId.trim();
      if (!trimmedId) {
        throw new Error(`Expected all keys in "${key}" in ${configPath} to be non-empty user IDs.`);
      }

      if (!Array.isArray(channels)) {
        throw new Error(
          `Expected "${key}.${userId}" in ${configPath} to be an array of channel IDs.`,
        );
      }

      const normalizedChannels: string[] = [];
      for (const channel of channels) {
        if (typeof channel === "string") {
          const trimmed = channel.trim();
          if (!trimmed) {
            throw new Error(
              `Expected all entries in "${key}.${userId}" in ${configPath} to be non-empty.`,
            );
          }
          normalizedChannels.push(trimmed);
        } else if (
          typeof channel === "number" &&
          Number.isFinite(channel) &&
          Number.isInteger(channel)
        ) {
          normalizedChannels.push(String(channel));
        } else {
          throw new Error(
            `Expected all entries in "${key}.${userId}" in ${configPath} to be strings or integers.`,
          );
        }
      }

      result[trimmedId] = normalizedChannels;
    }
    return result;
  }

  throw new Error(`Expected "${key}" in ${configPath} to be an array or object.`);
}

function normalizeUserId(entry: unknown, key: string, configPath: string): string {
  if (typeof entry === "string") {
    const trimmed = entry.trim();
    if (!trimmed) {
      throw new Error(`Expected all entries in "${key}" in ${configPath} to be non-empty.`);
    }
    return trimmed;
  }

  if (typeof entry === "number" && Number.isFinite(entry) && Number.isInteger(entry)) {
    return String(entry);
  }

  throw new Error(`Expected all entries in "${key}" in ${configPath} to be strings or integers.`);
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
