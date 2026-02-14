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

const USER_QUERY_DEQUEUED_ERROR = "Queued user query was removed.";
const MAX_QUEUED_MESSAGES_IN_PROMPT = 20;
const MAX_QUEUED_MESSAGE_CONTENT_LENGTH = 280;

const TELEGRAM_STOP_FOLLOW_UP_PROMPT =
  "The Telegram user intentionally sent /stop to abort the previous response. " +
  "Acknowledge that the previous response was stopped and ask what they want to do next.";

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
  private readonly pendingUserQueries: PendingUserQuery[] = [];

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

    await this.acquireActiveQuery({
      abortSignal: request.abortSignal,
      abortErrorMessage: "Cron query aborted.",
    });
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
    const command = parseSlashCommand(inbound.content);
    const isCompactCommand = command === "/compact";
    const isTelegramStopCommand = command === "/stop" && inbound.context.type === "telegram";
    const waitAbortController = new AbortController();
    const pendingQueueEntry: PendingUserQuery = {
      inbound,
      abortController: waitAbortController,
    };
    let drainedPendingQueries: ChatInboundMessage[] = [];

    if (isTelegramStopCommand) {
      this.abortActiveQuery();
      drainedPendingQueries = this.dequeuePendingUserQueries();
    }

    if (this.activeQuery && !isTelegramStopCommand) {
      try {
        await service.sendMessage(
          "Busy with another task right now. I queued your message and will reply when it finishes.",
          false,
          responseOptions,
        );
      } catch (error) {
        logger.error({ error, service: service.type }, "Failed to send queued notice");
      }
    }

    try {
      await this.acquireActiveQuery({
        abortSignal: isTelegramStopCommand ? undefined : waitAbortController.signal,
        abortErrorMessage: USER_QUERY_DEQUEUED_ERROR,
        onWaitStart: isTelegramStopCommand
          ? undefined
          : () => {
              this.pendingUserQueries.push(pendingQueueEntry);
            },
        onWaitEnd: isTelegramStopCommand
          ? undefined
          : () => {
              this.removePendingUserQuery(waitAbortController);
            },
      });
    } catch (error) {
      if (isDequeuedUserQueryError(error)) {
        return;
      }
      throw error;
    }
    let streamed = "";
    let fallbackFinal = "";
    const prompt = isCompactCommand
      ? "/compact"
      : isTelegramStopCommand
        ? buildTelegramStopFollowUpPrompt(drainedPendingQueries)
        : inbound.content;
    const platformContext = isCompactCommand || isTelegramStopCommand ? undefined : inbound.context;

    try {
      for await (const message of this.agent.query(prompt, {
        includePartialMessages: true,
        platformContext,
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

  private dequeuePendingUserQueries(): ChatInboundMessage[] {
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

  private removePendingUserQuery(abortController: AbortController): void {
    const index = this.pendingUserQueries.findIndex(
      (entry) => entry.abortController === abortController,
    );
    if (index < 0) {
      return;
    }
    this.pendingUserQueries.splice(index, 1);
  }

  private async acquireActiveQuery(options?: {
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
        throw new Error("Gateway is shutting down.");
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
      throw new Error("Gateway is shutting down.");
    }
    if (abortSignal?.aborted) {
      throw new Error(abortErrorMessage);
    }

    this.activeQuery = true;
  }
}

type QueryService = Pick<ChatService, "type" | "capabilities" | "sendMessage" | "sendStats">;
type PendingUserQuery = {
  inbound: ChatInboundMessage;
  abortController: AbortController;
};

function parseSlashCommand(content: string): string | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  const [command] = trimmed.split(/\s+/, 1);
  if (!command) {
    return null;
  }

  return command.toLowerCase();
}

function isDequeuedUserQueryError(error: unknown): boolean {
  return error instanceof Error && error.message === USER_QUERY_DEQUEUED_ERROR;
}

function buildTelegramStopFollowUpPrompt(queuedMessages: ChatInboundMessage[]): string {
  if (queuedMessages.length === 0) {
    return TELEGRAM_STOP_FOLLOW_UP_PROMPT;
  }

  const queuedLines = queuedMessages
    .slice(0, MAX_QUEUED_MESSAGES_IN_PROMPT)
    .map((message, index) => formatQueuedMessageForPrompt(message, index + 1));
  const omittedCount = queuedMessages.length - queuedLines.length;
  if (omittedCount > 0) {
    queuedLines.push(`${queuedLines.length + 1}. [${omittedCount} more queued message(s) omitted]`);
  }

  return [
    "The Telegram user intentionally sent /stop to abort the previous response.",
    "The messages below were waiting in queue and have been removed.",
    "Use them only as context, then check with the user before taking action.",
    "Queued messages:",
    ...queuedLines,
  ].join("\n");
}

function formatQueuedMessageForPrompt(message: ChatInboundMessage, index: number): string {
  const source = message.context.type;
  const channel = message.context.channelId?.trim();
  const attachmentCount = message.attachments?.length ?? 0;
  const normalizedContent = collapseWhitespace(message.content);
  const content = normalizedContent.slice(0, MAX_QUEUED_MESSAGE_CONTENT_LENGTH);
  const suffix = content.length < normalizedContent.length ? "..." : "";
  const labelParts: string[] = [source];
  if (channel) {
    labelParts.push(`channel:${channel}`);
  }
  if (attachmentCount > 0) {
    labelParts.push(`attachments:${attachmentCount}`);
  }

  return `${index}. [${labelParts.join(" ")}] ${content}${suffix || ""}`;
}

function collapseWhitespace(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "[empty]";
  }
  return trimmed.replace(/\s+/g, " ");
}

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
