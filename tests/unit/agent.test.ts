import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Agent } from "../../src/agent";

function createTempHome(): string {
  return mkdtempSync(join(tmpdir(), "xeno-agent-"));
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
}

describe("Agent session", () => {
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
            options: { cronContext?: { taskId: string; isolatedContext?: boolean } },
          ) => string;
        }
      ).augmentPrompt("summarize pending work", "resume", {
        cronContext: { taskId: "daily-sync", isolatedContext: true },
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
            options: { cronContext?: { taskId: string; isolatedContext?: boolean } },
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

  test("uses developer context (not run-cron-task wrapper) when cron is non-isolated", () => {
    const home = createTempHome();
    const agent = new Agent(home);

    try {
      const prompt = (
        agent as unknown as {
          augmentPrompt: (
            userPrompt: string,
            sessionType: "new" | "resume" | "compact",
            options: { cronContext?: { taskId: string; isolatedContext?: boolean } },
          ) => string;
        }
      ).augmentPrompt("summarize pending work", "resume", {
        cronContext: { taskId: "daily-sync", isolatedContext: false },
      });

      expect(prompt).toContain("You are triggered by cron task daily-sync.");
      expect(prompt).toContain("current local time is ");
      expect(prompt).not.toContain("/run-cron-task");
      expect(prompt).not.toContain("now:");
      expect(prompt).not.toContain("local_now:");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
