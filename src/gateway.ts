import type { AgentRuntime } from "./agent";
import { formatMessage } from "./chat/formatter";
import { ChatServiceRegistry } from "./chat/registry";
import { extractText, formatStats } from "./chat/stream";
import type { ChatInboundMessage, ChatService } from "./chat/service";
import { logger } from "./logger";

export interface GatewayConfig {
  home: string;
  agent: AgentRuntime;
  services: ChatService[];
}

export class Gateway {
  private readonly registry = new ChatServiceRegistry();
  private readonly agent: AgentRuntime;

  private activeQuery = false;
  private shuttingDown = false;

  constructor(config: GatewayConfig) {
    this.agent = config.agent;

    for (const service of config.services) {
      this.registry.register(service);
    }
  }

  async start(): Promise<void> {
    for (const service of this.registry.list()) {
      service.onUserMessage(async (message) => {
        await this.handleUserMessage(service, message);
      });

      service.onAbortRequest?.(() => {
        this.abortActiveQuery();
      });
    }

    this.registry.startAll();
    logger.info(
      { services: this.registry.list().map((service) => service.type) },
      "Gateway started",
    );
  }

  async stop(): Promise<void> {
    if (this.shuttingDown) {
      return;
    }
    this.shuttingDown = true;

    this.agent.abort();
    await this.registry.stopAll();
    logger.info("Gateway stopped");
  }

  waitForAnyServiceStop(): Promise<void> {
    return this.registry.waitForAnyStop();
  }

  requestAbort(): void {
    this.abortActiveQuery();
  }

  getSessionId(): string | null {
    return this.agent.getSessionId();
  }

  getConversationHistory() {
    return this.agent.getConversationHistory();
  }

  submitMessage(service: QueryService, inbound: ChatInboundMessage): Promise<void> {
    return this.handleUserMessage(service, inbound);
  }

  private abortActiveQuery(): void {
    if (!this.activeQuery) {
      return;
    }
    this.agent.abort();
  }

  private async handleUserMessage(
    service: QueryService,
    inbound: ChatInboundMessage,
  ): Promise<void> {
    if (this.shuttingDown) {
      return;
    }

    if (this.activeQuery) {
      await service.sendMessage("A request is already running. Press Ctrl-C to abort it.", false);
      return;
    }

    this.activeQuery = true;
    let streamed = "";
    let fallbackFinal = "";

    try {
      for await (const message of this.agent.query(inbound.content, {
        includePartialMessages: true,
        platformContext: inbound.context,
      })) {
        if (this.shuttingDown) {
          break;
        }

        if (message.type === "stream_event") {
          const delta = extractText(message);
          if (!delta) {
            continue;
          }

          streamed += delta;
          await service.sendMessage(
            formatMessage(streamed, inbound.context, service.capabilities),
            true,
          );
          continue;
        }

        if (message.type === "assistant") {
          fallbackFinal = extractText(message);
          if (fallbackFinal && !streamed) {
            await service.sendMessage(
              formatMessage(fallbackFinal, inbound.context, service.capabilities),
              true,
            );
          }
          continue;
        }

        if (message.type === "result") {
          await service.sendStats(formatStats(message));
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const lowered = errorMessage.toLowerCase();
      const isAbortError = lowered.includes("aborted") || lowered.includes("abort");
      if (!isAbortError) {
        logger.error({ error, service: service.type }, "Gateway query failed");
        fallbackFinal = `Error: ${errorMessage}`;
      }
    } finally {
      const finalContent = streamed || fallbackFinal || "[No response]";
      try {
        await service.sendMessage(
          formatMessage(finalContent, inbound.context, service.capabilities),
          false,
        );
      } catch (error) {
        logger.error({ error, service: service.type }, "Failed to send final message");
      }
      this.activeQuery = false;
    }
  }
}

type QueryService = Pick<ChatService, "type" | "capabilities" | "sendMessage" | "sendStats">;
