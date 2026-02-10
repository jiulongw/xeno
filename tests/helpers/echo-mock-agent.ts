import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentRuntime, ConversationTurn, LastChannel, QueryOptions } from "../../src/agent";
import type { PlatformContext } from "../../src/chat/service";

export interface EchoMockAgentOptions {
  sessionId?: string | null;
  history?: ConversationTurn[];
  chunkDelayMs?: number;
  failWith?: string | Error;
}

export class EchoMockAgent implements AgentRuntime {
  readonly calls: Array<{ prompt: string; options?: QueryOptions }> = [];

  private readonly sessionId: string | null;
  private readonly history: ConversationTurn[];
  private readonly chunkDelayMs: number;
  private readonly failWith: string | Error | undefined;
  private activeAbortController: AbortController | null = null;
  private lastChannel: LastChannel | null = null;

  abortCount = 0;

  constructor(options: EchoMockAgentOptions = {}) {
    this.sessionId = options.sessionId ?? "echo-session";
    this.history = options.history ?? [];
    this.chunkDelayMs = options.chunkDelayMs ?? 0;
    this.failWith = options.failWith;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  getLastChannel(): LastChannel | null {
    return this.lastChannel;
  }

  updateLastChannel(context: PlatformContext): void {
    const channelId = context.channelId?.trim();
    if (!channelId) {
      return;
    }
    this.lastChannel = {
      platform: context.type,
      channelId,
    };
  }

  async getConversationHistory(): Promise<ConversationTurn[]> {
    return this.history;
  }

  async *query(userPrompt: string, options?: QueryOptions): AsyncGenerator<SDKMessage> {
    this.calls.push({ prompt: userPrompt, options });
    const abortController = new AbortController();
    this.activeAbortController = abortController;

    try {
      if (this.failWith) {
        throw typeof this.failWith === "string" ? new Error(this.failWith) : this.failWith;
      }

      if (this.chunkDelayMs > 0) {
        await sleep(this.chunkDelayMs, undefined, { signal: abortController.signal });
      }

      yield {
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "text",
            text: userPrompt,
          },
        },
        parent_tool_use_id: null,
        uuid: randomUUID(),
        session_id: this.sessionId ?? "echo-session",
      } as SDKMessage;

      const result: SDKResultMessage = {
        type: "result",
        subtype: "success",
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: false,
        num_turns: 1,
        result: userPrompt,
        stop_reason: "end_turn",
        total_cost_usd: 0,
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        modelUsage: {},
        permission_denials: [],
        uuid: randomUUID(),
        session_id: this.sessionId ?? "echo-session",
      };

      yield result;
    } catch (error) {
      if (isAbortError(error)) {
        throw new Error("aborted");
      }
      throw error;
    } finally {
      if (this.activeAbortController === abortController) {
        this.activeAbortController = null;
      }
    }
  }

  abort(): void {
    this.abortCount += 1;
    this.activeAbortController?.abort();
  }
}

function isAbortError(value: unknown): boolean {
  return value instanceof Error && value.name === "AbortError";
}
