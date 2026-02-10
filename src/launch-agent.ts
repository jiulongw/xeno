import { spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LAUNCH_AGENT_BASE_DOMAIN = "cc.novacore.xeno";
const LAUNCH_AGENT_LABEL = `${LAUNCH_AGENT_BASE_DOMAIN}.gateway`;
const LOG_HOME_FALLBACK_NAME = "default-home";

export interface InstallLaunchAgentOptions {
  home?: string;
  executablePath?: string;
  cwd?: string;
  runtimePath?: string;
  pathEnv?: string;
}

export interface LaunchAgentResult {
  label: string;
  plistPath: string;
}

export function getLaunchAgentPlistPath(baseHome: string = homedir()): string {
  return join(baseHome, "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);
}

export async function installLaunchAgent(options: InstallLaunchAgentOptions = {}): Promise<
  LaunchAgentResult & {
    executablePath: string;
    stdoutPath: string;
    stderrPath: string;
  }
> {
  ensureMacOS();

  const executablePath = resolveInstallEntrypoint(options.executablePath, options.cwd);
  const runtimePath = resolveRuntimePath(options.runtimePath, options.cwd);
  const pathEnv = buildLaunchAgentPathEnv(runtimePath, options.pathEnv);
  const plistPath = getLaunchAgentPlistPath();
  const logPaths = buildLaunchAgentLogPaths(options.home);
  const plistContent = buildLaunchAgentPlist({
    executablePath,
    home: options.home,
    stdoutPath: logPaths.stdoutPath,
    stderrPath: logPaths.stderrPath,
    pathEnv,
  });

  await mkdir(dirname(plistPath), { recursive: true });
  await mkdir(getLaunchAgentLogsDir(), { recursive: true });
  await writeFile(plistPath, plistContent, "utf-8");

  const domain = getLaunchctlDomain();
  runCommand("launchctl", ["bootout", domain, plistPath], true);
  runCommand("launchctl", ["bootstrap", domain, plistPath]);

  return {
    label: LAUNCH_AGENT_LABEL,
    plistPath,
    executablePath,
    stdoutPath: logPaths.stdoutPath,
    stderrPath: logPaths.stderrPath,
  };
}

export function resolveInstallEntrypoint(
  executablePath: string | undefined,
  cwd: string = process.cwd(),
): string {
  return resolvePathValue(
    executablePath,
    "Failed to resolve install entrypoint from the running process path.",
    cwd,
  );
}

export function resolveRuntimePath(
  runtimePath: string | undefined,
  cwd: string = process.cwd(),
): string {
  return resolvePathValue(runtimePath, "Failed to resolve runtime path for launch agent.", cwd);
}

export async function uninstallLaunchAgent(): Promise<LaunchAgentResult> {
  ensureMacOS();

  const plistPath = getLaunchAgentPlistPath();
  const domain = getLaunchctlDomain();

  runCommand("launchctl", ["bootout", domain, plistPath], true);
  await rm(plistPath, { force: true });

  return {
    label: LAUNCH_AGENT_LABEL,
    plistPath,
  };
}

export function buildLaunchAgentProgramArguments(
  executablePath: string,
  home: string | undefined,
): string[] {
  const programArguments = [executablePath, "serve"];
  if (home?.trim()) {
    programArguments.push("--home", home.trim());
  }
  return programArguments;
}

export function buildLaunchAgentPlist(input: {
  executablePath: string;
  home?: string;
  stdoutPath: string;
  stderrPath: string;
  pathEnv: string;
}): string {
  const programArguments = buildLaunchAgentProgramArguments(input.executablePath, input.home);
  const programArgumentsXml = programArguments
    .map((arg) => `    <string>${escapeXml(arg)}</string>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${programArgumentsXml}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(input.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(input.stderrPath)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escapeXml(input.pathEnv)}</string>
  </dict>
</dict>
</plist>
`;
}

export function buildLaunchAgentPathEnv(
  runtimePath: string,
  processPath: string | undefined,
): string {
  const runtimeBinDir = dirname(runtimePath);
  const defaultPath = "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  const sourcePath = processPath?.trim() || defaultPath;
  const seen = new Set<string>();
  const entries = [runtimeBinDir, ...sourcePath.split(":")]
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .filter((entry) => {
      if (seen.has(entry)) {
        return false;
      }
      seen.add(entry);
      return true;
    });

  return entries.join(":");
}

export function getLaunchAgentLogsDir(baseHome: string = homedir()): string {
  return join(baseHome, ".xeno", "logs");
}

export function sanitizeHomeForLogName(home: string | undefined): string {
  const source = home?.trim() || LOG_HOME_FALLBACK_NAME;
  const safe = source
    .replaceAll(/[^A-Za-z0-9._-]+/g, "-")
    .replaceAll(/^-+/g, "")
    .replaceAll(/-+$/g, "");

  if (!safe) {
    return LOG_HOME_FALLBACK_NAME;
  }

  return safe.slice(0, 96);
}

export function formatLaunchAgentTimestamp(date: Date = new Date()): string {
  const year = date.getFullYear().toString().padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  const second = String(date.getSeconds()).padStart(2, "0");

  return `${year}${month}${day}-${hour}${minute}${second}`;
}

export function buildLaunchAgentLogPaths(
  home: string | undefined,
  date: Date = new Date(),
  baseHome: string = homedir(),
): {
  stdoutPath: string;
  stderrPath: string;
} {
  const homeName = sanitizeHomeForLogName(home);
  const timestamp = formatLaunchAgentTimestamp(date);
  const baseName = `${homeName}-${timestamp}`;
  const logsDir = getLaunchAgentLogsDir(baseHome);

  return {
    stdoutPath: join(logsDir, `${baseName}.out.log`),
    stderrPath: join(logsDir, `${baseName}.err.log`),
  };
}

function resolvePathValue(rawPath: string | undefined, errorMessage: string, cwd: string): string {
  const trimmed = rawPath?.trim();
  if (!trimmed) {
    throw new Error(errorMessage);
  }

  const pathValue = trimmed.startsWith("file://") ? fileURLToPath(trimmed) : trimmed;
  return isAbsolute(pathValue) ? pathValue : resolve(cwd, pathValue);
}

function getLaunchctlDomain(): string {
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new Error("Cannot determine current uid for launchctl domain.");
  }
  return `gui/${uid}`;
}

function runCommand(command: string, args: string[], allowFailure: boolean = false): void {
  const result = spawnSync(command, args, { encoding: "utf-8" });

  if (result.status === 0 || allowFailure) {
    return;
  }

  const stderr = result.stderr?.trim();
  const stdout = result.stdout?.trim();
  const output = stderr || stdout;
  const detail = output ? `: ${output}` : "";
  throw new Error(`Command failed: ${command} ${args.join(" ")}${detail}`);
}

function ensureMacOS(): void {
  if (process.platform !== "darwin") {
    throw new Error("LaunchAgent install/uninstall is only supported on macOS.");
  }
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
