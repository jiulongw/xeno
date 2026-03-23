import type { PlatformContext } from "../chat/service";
import type { Attachment } from "../media";

export type ProviderType = "claude" | "codex";

// --- Agent events (provider-agnostic message types) ---

export type AgentEvent = AgentInitEvent | AgentStreamEvent | AgentAssistantEvent | AgentResultEvent;

export interface AgentInitEvent {
  type: "init";
  sessionId: string;
}

export interface AgentStreamEvent {
  type: "stream";
  text: string;
}

export interface AgentAssistantEvent {
  type: "assistant";
  text: string;
}

export interface AgentResultEvent {
  type: "result";
  subtype: "success" | "error";
  sessionId: string;
  turns: number;
  stopReason: string | null;
  durationMs: number;
  apiDurationMs: number;
  costUsd: number;
  modelUsage?: Record<string, unknown>;
}

// --- Agent runtime interface & options ---

export interface QueryOptions {
  includePartialMessages?: boolean;
  mcpServers?: Record<string, unknown>;
  platformContext?: PlatformContext;
  cronContext?: CronContext;
  attachments?: Attachment[];
}

export interface CronContext {
  taskId: string;
  model?: string;
  isolatedContext?: boolean;
}

export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
}

export interface AgentRuntime {
  getSessionId(): string | null;
  getConversationHistory(): Promise<ConversationTurn[]>;
  query(userPrompt: string, options?: QueryOptions): AsyncGenerator<AgentEvent>;
  abort(): void;
  clearMainSessionId?(): void;
}

export interface AgentOptions {
  defaultModel?: string;
  parentHome?: string;
  channelKey?: string;
  mcpBridge?: {
    command: string;
    args: string[];
  };
}
