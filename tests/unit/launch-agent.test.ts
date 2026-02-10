import { describe, expect, test } from "bun:test";
import {
  buildLaunchAgentPathEnv,
  buildLaunchAgentLogPaths,
  buildLaunchAgentPlist,
  buildLaunchAgentProgramArguments,
  formatLaunchAgentTimestamp,
  getLaunchAgentLogsDir,
  getLaunchAgentPlistPath,
  resolveInstallEntrypoint,
  resolveRuntimePath,
  sanitizeHomeForLogName,
} from "../../src/launch-agent";

describe("launch-agent helpers", () => {
  test("builds program arguments without home", () => {
    expect(buildLaunchAgentProgramArguments("/usr/local/bin/xeno", undefined)).toEqual([
      "/usr/local/bin/xeno",
      "serve",
    ]);
  });

  test("builds program arguments with home", () => {
    expect(buildLaunchAgentProgramArguments("/opt/bin/xeno", "  /tmp/xeno-home  ")).toEqual([
      "/opt/bin/xeno",
      "serve",
      "--home",
      "/tmp/xeno-home",
    ]);
  });

  test("builds launch agent plist with escaped xml", () => {
    const plist = buildLaunchAgentPlist({
      executablePath: "/tmp/xeno&dev",
      home: "/tmp/<xeno>",
      stdoutPath: "/tmp/logs/stdout&.log",
      stderrPath: "/tmp/logs/stderr<.log",
      pathEnv: "/opt/homebrew/bin:/usr/bin:/bin",
    });

    expect(plist).toContain("<string>/tmp/xeno&amp;dev</string>");
    expect(plist).toContain("<string>/tmp/&lt;xeno&gt;</string>");
    expect(plist).toContain("<string>cc.novacore.xeno.gateway</string>");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<string>/tmp/logs/stdout&amp;.log</string>");
    expect(plist).toContain("<string>/tmp/logs/stderr&lt;.log</string>");
    expect(plist).toContain("<key>EnvironmentVariables</key>");
    expect(plist).toContain("<string>/opt/homebrew/bin:/usr/bin:/bin</string>");
  });

  test("resolves plist path under user's launch agents", () => {
    expect(getLaunchAgentPlistPath("/Users/tester")).toBe(
      "/Users/tester/Library/LaunchAgents/cc.novacore.xeno.gateway.plist",
    );
  });

  test("sanitizes home path for log file names", () => {
    expect(sanitizeHomeForLogName(" /tmp/xeno home/@dev ")).toBe("tmp-xeno-home-dev");
    expect(sanitizeHomeForLogName(undefined)).toBe("default-home");
  });

  test("formats timestamp for launch agent logs", () => {
    const date = new Date(2026, 1, 9, 16, 17, 18);
    expect(formatLaunchAgentTimestamp(date)).toBe("20260209-161718");
  });

  test("builds log paths from sanitized home and timestamp", () => {
    const date = new Date(2026, 1, 9, 16, 17, 18);
    const paths = buildLaunchAgentLogPaths(" /tmp/xeno home ", date, "/Users/tester");
    expect(paths.stdoutPath).toBe("/Users/tester/.xeno/logs/tmp-xeno-home-20260209-161718.out.log");
    expect(paths.stderrPath).toBe("/Users/tester/.xeno/logs/tmp-xeno-home-20260209-161718.err.log");
  });

  test("resolves log directory under user's home", () => {
    expect(getLaunchAgentLogsDir("/Users/tester")).toBe("/Users/tester/.xeno/logs");
  });

  test("resolves install entrypoint to absolute path", () => {
    expect(resolveInstallEntrypoint("bin/xeno.js", "/Users/tester/dev/xeno")).toBe(
      "/Users/tester/dev/xeno/bin/xeno.js",
    );
  });

  test("resolves install entrypoint from file URL", () => {
    expect(resolveInstallEntrypoint("file:///Users/tester/bin/xeno.js")).toBe(
      "/Users/tester/bin/xeno.js",
    );
  });

  test("throws when install entrypoint is missing", () => {
    expect(() => resolveInstallEntrypoint(undefined)).toThrow(
      "Failed to resolve install entrypoint from the running process path.",
    );
  });

  test("resolves runtime path to absolute path", () => {
    expect(resolveRuntimePath("bin/bun", "/Users/tester/dev/xeno")).toBe(
      "/Users/tester/dev/xeno/bin/bun",
    );
  });

  test("builds PATH with runtime directory first and deduplicates entries", () => {
    expect(
      buildLaunchAgentPathEnv("/Users/tester/.bun/bin/bun", "/usr/bin:/Users/tester/.bun/bin:/bin"),
    ).toBe("/Users/tester/.bun/bin:/usr/bin:/bin");
  });
});
