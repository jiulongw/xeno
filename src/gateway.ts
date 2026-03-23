import type { CronContext } from "./provider/types";
import type { ChannelRegistry } from "./channel/registry";
import type { ChannelSession } from "./channel/session";
import type { QueuedMessage } from "./channel/message-queue";
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
import { createReplyAttachmentMcpServer } from "./mcp/reply-attachment";

const USER_QUERY_DEQUEUED_ERROR = "Queued user query was removed.";
const MAX_QUEUED_MESSAGES_IN_PROMPT = 20;
const MAX_QUEUED_MESSAGE_CONTENT_LENGTH = 280;
const COMPACT_DONE_MESSAGE = "compact done";

const TELEGRAM_STOP_FOLLOW_UP_PROMPT =
  "The Telegram user intentionally sent /stop to abort the previous response. " +
  "Acknowledge that the previous response was stopped and ask what they want to do next.";

export interface GatewayConfig {
  home: string;
  channelRegistry: ChannelRegistry;
  services: ChatService[];
  mcpServers?: Record<string, unknown>;
  rpcMcpServers?: Record<string, unknown>;
}

export interface GatewayCronQueryRequest {
  taskId: string;
  prompt: string;
  model?: string;
  isolatedContext?: boolean;
  abortSignal?: AbortSignal;
  mcpServers?: Record<string, unknown>;
  session?: ChannelSession;
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
  private readonly channelRegistry: ChannelRegistry;
  private readonly mcpServers: Record<string, unknown> | undefined;
  private readonly rpcMcpServers: Record<string, unknown> | undefined;

  private shuttingDown = false;

  constructor(config: GatewayConfig) {
    this.channelRegistry = config.channelRegistry;
    this.mcpServers = config.mcpServers;
    this.rpcMcpServers = config.rpcMcpServers;

    for (const service of config.services) {
      this.registry.register(service);
    }
  }

  async start(): Promise<void> {
    for (const service of this.registry.list()) {
      service.onUserMessage(async (message) => {
        await this.handleUserMessage(service, message);
      });

      service.onAbortRequest?.((context) => {
        this.abortActiveQuery(service.type, context?.channelId);
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

    await this.channelRegistry.shutdown();
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

    const session = request.session ?? this.channelRegistry.getMainSession();
    await session.acquireActiveQuery({
      abortSignal: request.abortSignal,
      abortErrorMessage: "Cron query aborted.",
    });
    const startedAt = Date.now();
    let streamed = "";
    let fallbackFinal = "";

    const cronContext: CronContext = {
      taskId: request.taskId,
      model: request.model,
      isolatedContext: request.isolatedContext,
    };
    const cronMcpServers = mergeMcpServers(
      mergeMcpServers(this.mcpServers, session.mcpServers),
      request.mcpServers,
    );
    const onAbort = () => {
      session.agent.abort();
    };
    request.abortSignal?.addEventListener("abort", onAbort, { once: true });

    try {
      for await (const event of session.agent.query(request.prompt, {
        includePartialMessages: true,
        mcpServers: cronMcpServers,
        cronContext,
      })) {
        if (this.shuttingDown) {
          break;
        }

        if (event.type === "stream") {
          streamed += event.text;
          continue;
        }

        if (event.type === "assistant") {
          fallbackFinal = event.text;
        }
      }
    } finally {
      request.abortSignal?.removeEventListener("abort", onAbort);
      session.releaseActiveQuery();
    }

    return {
      result: streamed || fallbackFinal || "[No response]",
      durationMs: Date.now() - startedAt,
    };
  }

  getSessionId(): string | null {
    return this.channelRegistry.getMainSession().agent.getSessionId();
  }

  getConversationHistory() {
    return this.channelRegistry.getMainSession().agent.getConversationHistory();
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

  private abortActiveQuery(platform?: string, channelId?: string): void {
    let session: ChannelSession | undefined;
    if (platform && channelId) {
      session = this.channelRegistry.findSession(platform, channelId);
    }
    if (!session) {
      session = this.channelRegistry.getMainSession();
    }
    if (!session.activeQuery) {
      return;
    }
    session.abort();
  }

  private async handleUserMessage(
    service: QueryService,
    inbound: ChatInboundMessage,
  ): Promise<void> {
    if (this.shuttingDown) {
      return;
    }

    const chatType = inbound.context.metadata?.chatType as string | undefined;
    const chatTitle = inbound.context.metadata?.chatTitle as string | undefined;
    const session = await this.channelRegistry.resolve(
      inbound.context.type,
      inbound.context.channelId,
      chatType,
      chatTitle,
    );
    const isGroupChat = chatType === "group" || chatType === "supergroup";
    const isMentioned = inbound.context.metadata?.mentioned === true;

    // Group chat message queue: queue non-mentioned messages
    if (isGroupChat && !isMentioned) {
      if (session.messageQueue) {
        await session.messageQueue.append({
          timestamp: new Date().toISOString(),
          userId: inbound.context.userId,
          userName:
            (inbound.context.metadata?.firstName as string) ||
            (inbound.context.metadata?.username as string) ||
            undefined,
          content: inbound.content,
        });
        logger.debug(
          { channelKey: session.channelKey, content: inbound.content.slice(0, 80) },
          "Queued group chat message",
        );
      }
      return;
    }

    // Build response target so the reply goes to the right chat
    const responseTarget: OutboundMessageTarget | undefined = inbound.context.channelId
      ? { platform: inbound.context.type, channelId: inbound.context.channelId }
      : undefined;
    const responseOptions: OutboundMessageOptions = {
      reason: "response",
      target: responseTarget,
    };

    const command = parseSlashCommand(inbound.content);
    const isCompactCommand = command === "/compact";
    const isTelegramStopCommand = command === "/stop" && inbound.context.type === "telegram";
    const waitAbortController = new AbortController();
    const pendingQueueEntry = {
      inbound,
      abortController: waitAbortController,
    };
    let drainedPendingQueries: ChatInboundMessage[] = [];

    if (isTelegramStopCommand) {
      session.abort();
      drainedPendingQueries = session.dequeuePendingUserQueries();
    }

    if (session.activeQuery && !isTelegramStopCommand) {
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
      await session.acquireActiveQuery({
        abortSignal: isTelegramStopCommand ? undefined : waitAbortController.signal,
        abortErrorMessage: USER_QUERY_DEQUEUED_ERROR,
        onWaitStart: isTelegramStopCommand
          ? undefined
          : () => {
              session.pendingUserQueries.push(pendingQueueEntry);
            },
        onWaitEnd: isTelegramStopCommand
          ? undefined
          : () => {
              session.removePendingUserQuery(waitAbortController);
            },
      });
    } catch (error) {
      if (isDequeuedUserQueryError(error)) {
        return;
      }
      throw error;
    }

    // Flush queued group chat messages as context when mentioned
    let queuedContext = "";
    if (isGroupChat && isMentioned && session.messageQueue) {
      const queued = await session.messageQueue.flush();
      if (queued.length > 0) {
        queuedContext = formatQueuedGroupMessages(queued);
      }
    }

    let streamed = "";
    let finalAssistant = "";
    let failedResponse: string | null = null;
    let aborted = false;
    const collectedAttachments: Attachment[] = [];
    const basePrompt = isCompactCommand
      ? "/compact"
      : isTelegramStopCommand
        ? buildTelegramStopFollowUpPrompt(drainedPendingQueries)
        : inbound.content;
    const prompt = queuedContext ? `${queuedContext}\n\n${basePrompt}` : basePrompt;
    const platformContext = isCompactCommand || isTelegramStopCommand ? undefined : inbound.context;
    const sessionMcpServers = mergeMcpServers(this.mcpServers, session.mcpServers);
    const queryMcpServers =
      inbound.context.type === "rpc"
        ? mergeMcpServers(sessionMcpServers, this.rpcMcpServers)
        : mergeMcpServers(sessionMcpServers, {
            "xeno-reply-attachment": createReplyAttachmentMcpServer({
              sendAttachment: async (attachment) => {
                const supportedMediaTypes = service.capabilities.supportedMediaTypes;
                if (supportedMediaTypes && !supportedMediaTypes.includes(attachment.type)) {
                  return {
                    delivered: false,
                    reason: `${service.type} does not support ${attachment.type} attachments.`,
                  };
                }

                collectedAttachments.push(attachment);
                return { delivered: true };
              },
            }),
          });
    try {
      await service.startTyping?.({ target: responseTarget });
    } catch (error) {
      logger.warn({ error, service: service.type }, "Failed to start typing indicator");
    }

    try {
      for await (const event of session.agent.query(prompt, {
        includePartialMessages: false,
        platformContext,
        mcpServers: queryMcpServers,
        attachments: inbound.attachments,
      })) {
        if (this.shuttingDown) {
          break;
        }

        if (event.type === "stream") {
          streamed += event.text;
          continue;
        }

        if (event.type === "assistant") {
          finalAssistant = event.text;
          continue;
        }

        if (event.type === "result") {
          await service.sendStats(formatStats(event));
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const lowered = errorMessage.toLowerCase();
      const isAbortError = lowered.includes("aborted") || lowered.includes("abort");
      if (isAbortError) {
        aborted = true;
      } else {
        logger.error({ error, service: service.type }, "Gateway query failed");
        failedResponse = `Error: ${errorMessage}`;
      }
    } finally {
      const responseContent = failedResponse ?? (finalAssistant || streamed);
      const hasResponseContent = responseContent.trim().length > 0;
      const hasAttachments = collectedAttachments.length > 0;
      const skipPlaceholderOnAbort = aborted && !hasResponseContent;
      const useCompactDoneMessage =
        isCompactCommand && !aborted && !failedResponse && !hasResponseContent;
      const finalOptions: OutboundMessageOptions = {
        ...responseOptions,
        attachments: collectedAttachments.length > 0 ? [...collectedAttachments] : undefined,
        ...(skipPlaceholderOnAbort ? { suppressText: true } : {}),
      };

      if (!skipPlaceholderOnAbort || hasAttachments) {
        const finalContent = hasResponseContent
          ? responseContent
          : useCompactDoneMessage
            ? COMPACT_DONE_MESSAGE
            : "[No response]";
        try {
          await service.sendMessage(
            formatMessage(finalContent, inbound.context, service.capabilities),
            false,
            finalOptions,
          );
        } catch (error) {
          logger.error({ error, service: service.type }, "Failed to send final message");
        }
      }
      try {
        await service.stopTyping?.();
      } catch (error) {
        logger.warn({ error, service: service.type }, "Failed to stop typing indicator");
      }
      session.releaseActiveQuery();
    }
  }

  private resolveLastChannelTarget(): OutboundMessageTarget | null {
    return this.channelRegistry.getMainChannelTarget();
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
}

type QueryService = Pick<
  ChatService,
  "type" | "capabilities" | "sendMessage" | "sendStats" | "startTyping" | "stopTyping"
>;

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

function formatQueuedGroupMessages(messages: QueuedMessage[]): string {
  const recent = messages.slice(-MAX_QUEUED_MESSAGES_IN_PROMPT);
  const omitted = messages.length - recent.length;
  const lines: string[] = [];

  if (omitted > 0) {
    lines.push(`[${omitted} earlier message(s) omitted]`);
  }

  for (const msg of recent) {
    const name = msg.userName || msg.userId || "unknown";
    const content = collapseWhitespace(msg.content).slice(0, MAX_QUEUED_MESSAGE_CONTENT_LENGTH);
    lines.push(`[${msg.timestamp}] ${name}: ${content}`);
  }

  return `<developer>Recent group chat messages since last @mention:\n${lines.join("\n")}</developer>`;
}

function collapseWhitespace(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "[empty]";
  }
  return trimmed.replace(/\s+/g, " ");
}

function mergeMcpServers(
  base: Record<string, unknown> | undefined,
  extra: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
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
