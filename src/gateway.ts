import type { AgentRuntime, CronContext } from "./agent";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { formatMessage } from "./chat/formatter";
import { ChatServiceRegistry } from "./chat/registry";
import { extractText, formatStats } from "./chat/stream";
import type {
  ChatInboundMessage,
  ChatService,
  OutboundMessageOptions,
  OutboundMessageTarget,
} from "./chat/service";
import { logger } from "./logger";
import type { Attachment } from "./media";

export interface GatewayConfig {
  home: string;
  agent: AgentRuntime;
  services: ChatService[];
  mcpServers?: Record<string, McpServerConfig>;
}

export interface GatewayCronQueryRequest {
  taskId: string;
  prompt: string;
  model?: string;
  abortSignal?: AbortSignal;
  mcpServers?: Record<string, McpServerConfig>;
}

export interface GatewayCronQueryResult {
  result: string;
  durationMs: number;
  attachments?: Attachment[];
}

export interface SendMessageRequest {
  content: string;
  target?: OutboundMessageTarget;
  attachments?: Attachment[];
}

export interface SendMessageResult {
  delivered: boolean;
  target?: OutboundMessageTarget;
  reason?: string;
}

export class Gateway {
  private readonly registry = new ChatServiceRegistry();
  private readonly agent: AgentRuntime;
  private readonly mcpServers: Record<string, McpServerConfig> | undefined;

  private activeQuery = false;
  private shuttingDown = false;

  constructor(config: GatewayConfig) {
    this.agent = config.agent;
    this.mcpServers = config.mcpServers;

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

  async runCronQuery(request: GatewayCronQueryRequest): Promise<GatewayCronQueryResult> {
    if (this.shuttingDown) {
      throw new Error("Gateway is shutting down.");
    }

    if (request.abortSignal?.aborted) {
      throw new Error("Cron query aborted.");
    }

    await this.waitForActiveQueryToFinish(request.abortSignal);

    this.activeQuery = true;
    const startedAt = Date.now();
    let streamed = "";
    let fallbackFinal = "";

    const cronContext: CronContext = {
      taskId: request.taskId,
      model: request.model,
    };
    const cronMcpServers = mergeMcpServers(this.mcpServers, request.mcpServers);
    const onAbort = () => {
      this.agent.abort();
    };
    request.abortSignal?.addEventListener("abort", onAbort, { once: true });

    try {
      for await (const message of this.agent.query(request.prompt, {
        includePartialMessages: true,
        mcpServers: cronMcpServers,
        cronContext,
      })) {
        if (this.shuttingDown) {
          break;
        }

        if (message.type === "stream_event") {
          const delta = extractText(message);
          if (delta) {
            streamed += delta;
          }
          continue;
        }

        if (message.type === "assistant") {
          const text = extractText(message);
          if (text) {
            fallbackFinal = text;
          }
        }
      }
    } finally {
      request.abortSignal?.removeEventListener("abort", onAbort);
      this.activeQuery = false;
    }

    return {
      result: streamed || fallbackFinal || "[No response]",
      durationMs: Date.now() - startedAt,
    };
  }

  getSessionId(): string | null {
    return this.agent.getSessionId();
  }

  getConversationHistory() {
    return this.agent.getConversationHistory();
  }

  async broadcastMessage(content: string): Promise<void> {
    await this.sendMessage({ content });
  }

  async sendMessage(request: SendMessageRequest): Promise<SendMessageResult> {
    const targetResolution = this.resolveTarget(request.target);
    if (!targetResolution.target) {
      logger.warn(
        {
          target: request.target,
          reason: targetResolution.reason,
        },
        "Skipped proactive broadcast because target could not be resolved",
      );
      return {
        delivered: false,
        reason: targetResolution.reason,
      };
    }

    const target = targetResolution.target;

    const options: OutboundMessageOptions = {
      reason: "proactive",
      target,
    };
    if (request.attachments && request.attachments.length > 0) {
      options.attachments = request.attachments;
    }
    const services = this.registry.list();
    const results = await Promise.allSettled(
      services.map(async (service) => {
        await service.sendMessage(request.content, false, options);
      }),
    );

    for (const [index, result] of results.entries()) {
      if (result.status === "rejected") {
        const service = services[index];
        logger.error(
          { error: result.reason, service: service?.type, target },
          "Failed message delivery",
        );
      }
    }

    return {
      delivered: true,
      target,
    };
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

    this.agent.updateLastChannel(inbound.context);

    const responseOptions: OutboundMessageOptions = {
      reason: "response",
    };

    if (this.activeQuery) {
      await service.sendMessage(
        "A request is already running. Press Ctrl-C to abort it.",
        false,
        responseOptions,
      );
      return;
    }

    this.activeQuery = true;
    let streamed = "";
    let fallbackFinal = "";

    try {
      for await (const message of this.agent.query(inbound.content, {
        includePartialMessages: true,
        platformContext: inbound.context,
        mcpServers: this.mcpServers,
        attachments: inbound.attachments,
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
            responseOptions,
          );
          continue;
        }

        if (message.type === "assistant") {
          fallbackFinal = extractText(message);
          if (fallbackFinal && !streamed) {
            await service.sendMessage(
              formatMessage(fallbackFinal, inbound.context, service.capabilities),
              true,
              responseOptions,
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
          responseOptions,
        );
      } catch (error) {
        logger.error({ error, service: service.type }, "Failed to send final message");
      }
      this.activeQuery = false;
    }
  }

  private resolveLastChannelTarget(): OutboundMessageTarget | null {
    const lastChannel = this.agent.getLastChannel();
    if (!lastChannel) {
      return null;
    }

    return {
      platform: lastChannel.platform,
      channelId: lastChannel.channelId,
    };
  }

  private resolveTarget(targetOverride: OutboundMessageTarget | undefined): {
    target: OutboundMessageTarget | null;
    reason?: string;
  } {
    if (targetOverride) {
      const channelId = targetOverride.channelId.trim();
      if (!channelId) {
        return {
          target: null,
          reason: "target.channelId must be a non-empty string.",
        };
      }
      return {
        target: {
          platform: targetOverride.platform,
          channelId,
        },
      };
    }

    const target = this.resolveLastChannelTarget();
    if (!target) {
      return {
        target: null,
        reason: "No last channel is known yet.",
      };
    }

    return { target };
  }

  private async waitForActiveQueryToFinish(abortSignal?: AbortSignal): Promise<void> {
    while (this.activeQuery) {
      if (this.shuttingDown) {
        throw new Error("Gateway is shutting down.");
      }
      if (abortSignal?.aborted) {
        throw new Error("Cron query aborted.");
      }

      await new Promise<void>((resolve) => {
        setTimeout(resolve, 50);
      });
    }
  }
}

type QueryService = Pick<ChatService, "type" | "capabilities" | "sendMessage" | "sendStats">;

function mergeMcpServers(
  base: Record<string, McpServerConfig> | undefined,
  extra: Record<string, McpServerConfig> | undefined,
): Record<string, McpServerConfig> | undefined {
  if (!base && !extra) {
    return undefined;
  }
  if (!base) {
    return extra;
  }
  if (!extra) {
    return base;
  }
  return { ...base, ...extra };
}
