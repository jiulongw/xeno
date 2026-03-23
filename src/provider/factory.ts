import type { AgentOptions, AgentRuntime, ProviderType } from "./types";
import { ClaudeAgent } from "./claude";
import { CodexAgent } from "./codex";

export function createAgent(
  dir: string,
  provider: ProviderType,
  options?: AgentOptions,
): AgentRuntime {
  switch (provider) {
    case "claude":
      return new ClaudeAgent(dir, options);
    case "codex":
      return new CodexAgent(dir, options);
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}
