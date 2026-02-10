import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface AppConfig {
  defaultHome?: string;
  telegramBotToken?: string;
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

  return {
    defaultHome: defaultHome?.trim() || undefined,
    telegramBotToken: telegramBotToken?.trim() || undefined,
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

function expandHomeShortcut(pathValue: string, baseHome: string = homedir()): string {
  if (pathValue === "~") {
    return baseHome;
  }

  if (pathValue.startsWith("~/")) {
    return join(baseHome, pathValue.slice(2));
  }

  return pathValue;
}
