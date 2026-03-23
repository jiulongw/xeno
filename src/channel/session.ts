import type { AgentRuntime } from "../provider/types";
import type { ChatInboundMessage } from "../chat/service";
import type { CronEngine } from "../cron/engine";
import type { ChannelMessageQueue } from "./message-queue";

export interface ChannelSessionOptions {
  messageQueue?: ChannelMessageQueue | null;
  cronEngine?: CronEngine | null;
  mcpServers?: Record<string, unknown>;
}

export interface PendingUserQuery {
  inbound: ChatInboundMessage;
  abortController: AbortController;
}

export class ChannelSession {
  readonly channelKey: string;
  readonly agent: AgentRuntime;
  readonly messageQueue: ChannelMessageQueue | null;
  readonly cronEngine: CronEngine | null;
  readonly mcpServers: Record<string, unknown> | undefined;

  activeQuery = false;
  private shuttingDown = false;
  readonly pendingUserQueries: PendingUserQuery[] = [];

  constructor(channelKey: string, agent: AgentRuntime, options?: ChannelSessionOptions) {
    this.channelKey = channelKey;
    this.agent = agent;
    this.messageQueue = options?.messageQueue ?? null;
    this.cronEngine = options?.cronEngine ?? null;
    this.mcpServers = options?.mcpServers;
  }

  async acquireActiveQuery(options?: {
    abortSignal?: AbortSignal;
    abortErrorMessage?: string;
    onWaitStart?: () => void;
    onWaitEnd?: () => void;
  }): Promise<void> {
    const abortSignal = options?.abortSignal;
    const abortErrorMessage = options?.abortErrorMessage ?? "Query aborted.";
    let waiting = false;

    while (this.activeQuery) {
      if (!waiting) {
        waiting = true;
        options?.onWaitStart?.();
      }
      if (this.shuttingDown) {
        if (waiting) {
          options?.onWaitEnd?.();
        }
        throw new Error("Session is shutting down.");
      }
      if (abortSignal?.aborted) {
        if (waiting) {
          options?.onWaitEnd?.();
        }
        throw new Error(abortErrorMessage);
      }

      await new Promise<void>((resolve) => {
        setTimeout(resolve, 50);
      });
    }

    if (waiting) {
      options?.onWaitEnd?.();
    }
    if (this.shuttingDown) {
      throw new Error("Session is shutting down.");
    }
    if (abortSignal?.aborted) {
      throw new Error(abortErrorMessage);
    }

    this.activeQuery = true;
  }

  releaseActiveQuery(): void {
    this.activeQuery = false;
  }

  dequeuePendingUserQueries(): ChatInboundMessage[] {
    if (this.pendingUserQueries.length === 0) {
      return [];
    }

    const drained = this.pendingUserQueries.map((entry) => entry.inbound);
    const pending = [...this.pendingUserQueries];
    this.pendingUserQueries.length = 0;
    for (const entry of pending) {
      entry.abortController.abort();
    }

    return drained;
  }

  removePendingUserQuery(abortController: AbortController): void {
    const index = this.pendingUserQueries.findIndex(
      (entry) => entry.abortController === abortController,
    );
    if (index < 0) {
      return;
    }
    this.pendingUserQueries.splice(index, 1);
  }

  abort(): void {
    this.agent.abort();
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.agent.abort();
    await this.cronEngine?.stop();
  }
}
