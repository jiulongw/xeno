import { describe, expect, test } from "bun:test";
import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { extractText, formatStats } from "../../../src/chat/stream";

describe("extractText", () => {
  test("extracts concatenated assistant text blocks", () => {
    const message = {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "hello " },
          { type: "tool_use", name: "Edit" },
          { type: "text", text: "world" },
        ],
      },
    } as SDKMessage;

    expect(extractText(message)).toBe("hello world");
  });

  test("extracts stream event text from content block delta", () => {
    const message = {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: {
          type: "text_delta",
          text: "delta",
        },
      },
    } as SDKMessage;

    expect(extractText(message)).toBe("delta");
  });
});

describe("formatStats", () => {
  test("formats important result fields", () => {
    const result: SDKResultMessage = {
      type: "result",
      subtype: "success",
      duration_ms: 2_345,
      duration_api_ms: 1_500,
      is_error: false,
      num_turns: 3,
      result: "ok",
      stop_reason: "end_turn",
      total_cost_usd: 0.0123456,
      usage: {
        input_tokens: 1,
        output_tokens: 2,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      modelUsage: {},
      permission_denials: [],
      uuid: "123e4567-e89b-12d3-a456-426614174000",
      session_id: "session-1",
    };

    expect(formatStats(result)).toBe(
      "result=success | turns=3 | cost=$0.012346 | duration=2.35s | api=1.50s | stop=end_turn",
    );
  });
});
