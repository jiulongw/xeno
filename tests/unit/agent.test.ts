import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { Agent } from "../../src/agent";

function createTempHome(): string {
  return mkdtempSync(join(tmpdir(), "xeno-agent-"));
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
}

describe("Agent session last_channel", () => {
  test("persists and reloads last_channel in session.json", () => {
    const home = createTempHome();
    const sessionPath = join(home, ".xeno", "session.json");

    try {
      mkdirSync(join(home, ".xeno"), { recursive: true });
      writeFileSync(
        sessionPath,
        JSON.stringify(
          {
            main_session_id: "session-1",
          },
          null,
          2,
        ),
      );

      const agent = new Agent(home);
      expect(agent.getLastChannel()).toBeNull();

      agent.updateLastChannel({
        type: "telegram",
        channelId: "1001",
      });

      expect(readJson(sessionPath)).toEqual({
        main_session_id: "session-1",
        last_channel: {
          platform: "telegram",
          channel_id: "1001",
        },
      });

      const reloaded = new Agent(home);
      expect(reloaded.getLastChannel()).toEqual({
        platform: "telegram",
        channelId: "1001",
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("skips session.json rewrite when last_channel is unchanged", async () => {
    const home = createTempHome();
    const agent = new Agent(home);
    const sessionPath = join(home, ".xeno", "session.json");

    try {
      agent.updateLastChannel({
        type: "telegram",
        channelId: "1001",
      });

      const firstStat = statSync(sessionPath);
      const firstContents = readFileSync(sessionPath, "utf-8");
      await sleep(20);

      agent.updateLastChannel({
        type: "telegram",
        channelId: "1001",
      });

      const secondStat = statSync(sessionPath);
      const secondContents = readFileSync(sessionPath, "utf-8");

      expect(secondContents).toBe(firstContents);
      expect(secondStat.mtimeMs).toBe(firstStat.mtimeMs);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("does not persist last_channel when channelId is omitted", () => {
    const home = createTempHome();
    const agent = new Agent(home);

    try {
      agent.updateLastChannel({
        type: "console",
      });

      expect(agent.getLastChannel()).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("clearMainSessionId nulls main_session_id and keeps other session fields", () => {
    const home = createTempHome();
    const sessionPath = join(home, ".xeno", "session.json");

    try {
      mkdirSync(join(home, ".xeno"), { recursive: true });
      writeFileSync(
        sessionPath,
        JSON.stringify(
          {
            main_session_id: "session-1",
            last_channel: {
              platform: "telegram",
              channel_id: "1001",
            },
          },
          null,
          2,
        ),
      );

      const agent = new Agent(home);
      expect(agent.getSessionId()).toBe("session-1");

      agent.clearMainSessionId();

      expect(agent.getSessionId()).toBeNull();
      expect(readJson(sessionPath)).toEqual({
        main_session_id: null,
        last_channel: {
          platform: "telegram",
          channel_id: "1001",
        },
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("Agent augmentPrompt cron context", () => {
  test("adds explicit timezone-aware fields for run-cron-task", () => {
    const home = createTempHome();
    const agent = new Agent(home);

    try {
      const prompt = (
        agent as unknown as {
          augmentPrompt: (
            userPrompt: string,
            sessionType: "new" | "resume" | "compact",
            options: { cronContext?: { taskId: string } },
          ) => string;
        }
      ).augmentPrompt("summarize pending work", "resume", {
        cronContext: { taskId: "daily-sync" },
      });

      expect(prompt).toContain("/run-cron-task task_id:daily-sync");
      expect(prompt).toMatch(/\snow:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
      expect(prompt).toMatch(/ local_now:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}/);
      expect(prompt).not.toContain("local_tz:");
      expect(prompt).not.toContain("local_hour:");
      expect(prompt).not.toContain("local_period:");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("uses heartbeat cron developer context with current local time", () => {
    const home = createTempHome();
    const agent = new Agent(home);

    try {
      const prompt = (
        agent as unknown as {
          augmentPrompt: (
            userPrompt: string,
            sessionType: "new" | "resume" | "compact",
            options: { cronContext?: { taskId: string } },
          ) => string;
        }
      ).augmentPrompt("check status", "resume", {
        cronContext: { taskId: "__heartbeat__" },
      });

      expect(prompt).toContain("You are triggered by cron task __heartbeat__.");
      expect(prompt).toContain("current local time is ");
      expect(prompt).not.toContain("/heartbeat ");
      expect(prompt).not.toContain("/run-cron-task");
      expect(prompt).not.toContain("now:");
      expect(prompt).not.toContain("local_now:");
      expect(prompt).not.toContain("local_tz:");
      expect(prompt).not.toContain("local_hour:");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
