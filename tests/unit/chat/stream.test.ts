import { describe, expect, test } from "bun:test";
import type { AgentEvent, AgentResultEvent } from "../../../src/provider/types";
import { extractText, formatStats } from "../../../src/chat/stream";

describe("extractText", () => {
  test("extracts assistant text", () => {
    const event: AgentEvent = {
      type: "assistant",
      text: "hello world",
    };

    expect(extractText(event)).toBe("hello world");
  });

  test("extracts stream event text", () => {
    const event: AgentEvent = {
      type: "stream",
      text: "delta",
    };

    expect(extractText(event)).toBe("delta");
  });

  test("returns empty for result events", () => {
    const event: AgentEvent = {
      type: "result",
      subtype: "success",
      sessionId: "s1",
      turns: 1,
      stopReason: "end_turn",
      durationMs: 100,
      apiDurationMs: 50,
      costUsd: 0.01,
    };

    expect(extractText(event)).toBe("");
  });
});

describe("formatStats", () => {
  test("formats important result fields", () => {
    const result: AgentResultEvent = {
      type: "result",
      subtype: "success",
      sessionId: "session-1",
      turns: 3,
      stopReason: "end_turn",
      durationMs: 2_345,
      apiDurationMs: 1_500,
      costUsd: 0.0123456,
    };

    expect(formatStats(result)).toBe(
      "result=success | turns=3 | cost=$0.012346 | duration=2.35s | api=1.50s | stop=end_turn",
    );
  });
});
