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
});
