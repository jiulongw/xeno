import type { AgentEvent, AgentResultEvent } from "../provider/types";

export function extractText(event: AgentEvent): string {
  if (event.type === "assistant" || event.type === "stream") {
    return event.text;
  }
  return "";
}

export function formatStats(result: AgentResultEvent): string {
  const durationSec = (result.durationMs / 1000).toFixed(2);
  const apiDurationSec = (result.apiDurationMs / 1000).toFixed(2);
  const cost = result.costUsd.toFixed(6);

  return [
    `result=${result.subtype}`,
    `turns=${result.turns}`,
    `cost=$${cost}`,
    `duration=${durationSec}s`,
    `api=${apiDurationSec}s`,
    `stop=${result.stopReason ?? "none"}`,
  ].join(" | ");
}
