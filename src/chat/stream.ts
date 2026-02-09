import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

export function extractText(message: SDKMessage): string {
  if (message.type === "assistant") {
    const maybeContent = (message.message as { content?: unknown }).content;
    if (!Array.isArray(maybeContent)) {
      return "";
    }

    let text = "";
    for (const block of maybeContent) {
      const record = asRecord(block);
      if (!record || record.type !== "text") {
        continue;
      }
      const blockText = record.text;
      if (typeof blockText === "string") {
        text += blockText;
      }
    }
    return text;
  }

  if (message.type !== "stream_event") {
    return "";
  }

  const event = asRecord(message.event);
  if (!event) {
    return "";
  }

  if (event.type === "content_block_start") {
    const block = asRecord(event.content_block);
    if (block?.type === "text" && typeof block.text === "string") {
      return block.text;
    }
    return "";
  }

  if (event.type === "content_block_delta") {
    const delta = asRecord(event.delta);
    if (delta?.type === "text_delta" && typeof delta.text === "string") {
      return delta.text;
    }
    return "";
  }

  return "";
}

export function formatStats(result: SDKResultMessage): string {
  const durationSec = (result.duration_ms / 1000).toFixed(2);
  const apiDurationSec = (result.duration_api_ms / 1000).toFixed(2);
  const cost = result.total_cost_usd.toFixed(6);

  return [
    `result=${result.subtype}`,
    `turns=${result.num_turns}`,
    `cost=$${cost}`,
    `duration=${durationSec}s`,
    `api=${apiDurationSec}s`,
    `stop=${result.stop_reason ?? "none"}`,
  ].join(" | ");
}
