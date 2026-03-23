import { setTimeout as sleep } from "node:timers/promises";
import type {
  AgentEvent,
  AgentRuntime,
  ConversationTurn,
  QueryOptions,
} from "../../src/provider/types";

export interface EchoMockAgentOptions {
  sessionId?: string | null;
  history?: ConversationTurn[];
  chunkDelayMs?: number;
  failWith?: string | Error;
  emitStreamText?: boolean;
}

export class EchoMockAgent implements AgentRuntime {
  readonly calls: Array<{ prompt: string; options?: QueryOptions }> = [];

  private readonly sessionId: string | null;
  private readonly history: ConversationTurn[];
  private readonly chunkDelayMs: number;
  private readonly failWith: string | Error | undefined;
  private readonly emitStreamText: boolean;
  private activeAbortController: AbortController | null = null;

  abortCount = 0;

  constructor(options: EchoMockAgentOptions = {}) {
    this.sessionId = options.sessionId ?? "echo-session";
    this.history = options.history ?? [];
    this.chunkDelayMs = options.chunkDelayMs ?? 0;
    this.failWith = options.failWith;
    this.emitStreamText = options.emitStreamText ?? true;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  async getConversationHistory(): Promise<ConversationTurn[]> {
    return this.history;
  }

  async *query(userPrompt: string, options?: QueryOptions): AsyncGenerator<AgentEvent> {
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

      if (this.emitStreamText) {
        yield {
          type: "stream",
          text: userPrompt,
        };
      }

      yield {
        type: "result",
        subtype: "success",
        sessionId: this.sessionId ?? "echo-session",
        turns: 1,
        stopReason: "end_turn",
        durationMs: 1,
        apiDurationMs: 1,
        costUsd: 0,
        modelUsage: {},
      };
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
