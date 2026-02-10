import { Bot, GrammyError, HttpError, type Context } from "grammy";

import { logger } from "../../logger";
import type {
  AbortRequestHandler,
  ChatInboundMessage,
  ChatService,
  OutboundMessageOptions,
  PlatformCapabilities,
  PlatformType,
  UserMessageHandler,
} from "../service";

export interface TelegramPlatformOptions {
  home: string;
  token: string;
}

export class TelegramPlatform implements ChatService {
  readonly type: PlatformType = "telegram";
  readonly capabilities: PlatformCapabilities = {
    supportsStreaming: true,
    supportsMarkdownTables: false,
  };

  private readonly home: string;
  private readonly token: string;
  private readonly platformLogger;

  private bot: Bot | null = null;
  private running = false;

  private onUserMessageHandler: UserMessageHandler = () => undefined;
  private onAbortRequestHandler: AbortRequestHandler = () => undefined;
  private inboundQueue: Promise<void> = Promise.resolve();

  private activeChatId: number | null = null;
  private activeMessageId: number | null = null;
  private activeText = "";
  private pendingPartial: string | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private lastEditAt = 0;
  private readonly minEditIntervalMs = 1_000;

  constructor(options: TelegramPlatformOptions) {
    this.home = options.home;
    this.token = options.token;
    this.platformLogger = logger.child({ service: "telegram", home: this.home });
  }

  onUserMessage(handler: UserMessageHandler): void {
    this.onUserMessageHandler = handler;
  }

  onAbortRequest(handler: AbortRequestHandler): void {
    this.onAbortRequestHandler = handler;
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;

    this.platformLogger.info("Telegram platform starting");
    const bot = new Bot(this.token);
    this.bot = bot;

    bot.catch((error) => {
      const context = error.ctx;
      this.platformLogger.error(
        {
          updateId: context.update.update_id,
          error:
            error.error instanceof GrammyError || error.error instanceof HttpError
              ? error.error.message
              : String(error.error),
        },
        "Telegram update error",
      );
    });

    bot.command("start", (ctx) => {
      this.platformLogger.info(
        {
          userId: ctx.from ? String(ctx.from.id) : undefined,
          channelId: ctx.chat ? String(ctx.chat.id) : undefined,
          chatType: ctx.chat?.type,
          username: ctx.from?.username,
        },
        "Telegram /start received",
      );
    });

    bot.on("message:text", (ctx) => {
      const text = ctx.message.text.trim();
      if (!text || text.startsWith("/")) {
        return;
      }

      this.inboundQueue = this.inboundQueue
        .then(async () => {
          await this.handleIncomingText(ctx, text);
        })
        .catch((error) => {
          this.platformLogger.error({ error }, "Telegram message handling failed");
        });
    });

    try {
      await bot.start({
        allowed_updates: ["message"],
      });
    } finally {
      this.running = false;
      this.clearPendingTimer();
      this.clearActiveReplyState();
      this.platformLogger.info("Telegram platform stopped");
    }
  }

  async stop(): Promise<void> {
    this.clearPendingTimer();
    await this.flushPendingPartial();
    this.clearActiveReplyState();
    this.onAbortRequestHandler();

    if (this.bot && this.running) {
      this.platformLogger.info("Telegram shutdown");
      this.bot.stop();
    }
  }

  async sendMessage(
    content: string,
    isPartial: boolean,
    options?: OutboundMessageOptions,
  ): Promise<void> {
    if (!this.bot) {
      return;
    }

    const normalized = content.trim().length > 0 ? content : "[No response]";

    if (options?.reason === "proactive") {
      const target = options.target;
      if (!target || target.platform !== this.type) {
        return;
      }

      const targetChatId = this.parseChatId(target.channelId);
      if (targetChatId === null) {
        this.platformLogger.warn({ target }, "Skipping Telegram message: invalid chat ID");
        return;
      }

      if (!isPartial) {
        await this.bot.api.sendMessage(targetChatId, normalized);
      }
      return;
    }

    if (this.activeChatId === null) {
      return;
    }

    if (this.activeMessageId === null) {
      const message = await this.bot.api.sendMessage(this.activeChatId, normalized);
      this.activeMessageId = message.message_id;
      this.activeText = normalized;
      this.lastEditAt = Date.now();
      return;
    }

    if (!isPartial) {
      this.pendingPartial = null;
      this.clearPendingTimer();
      await this.editActiveMessage(normalized);
      return;
    }

    const elapsed = Date.now() - this.lastEditAt;
    if (elapsed >= this.minEditIntervalMs) {
      await this.editActiveMessage(normalized);
      return;
    }

    this.pendingPartial = normalized;
    this.schedulePartialFlush(this.minEditIntervalMs - elapsed);
  }

  async sendStats(_stats: string): Promise<void> {
    // Intentionally no-op for Telegram to avoid noisy debug metadata in chats.
    return;
  }

  private async handleIncomingText(ctx: Context, text: string): Promise<void> {
    this.activeChatId = ctx.chat?.id ?? null;
    this.activeMessageId = null;
    this.activeText = "";
    this.pendingPartial = null;
    this.clearPendingTimer();
    this.lastEditAt = 0;

    const inbound: ChatInboundMessage = {
      content: text,
      context: {
        type: "telegram",
        userId: ctx.from ? String(ctx.from.id) : undefined,
        channelId: this.activeChatId !== null ? String(this.activeChatId) : undefined,
        metadata: {
          username: ctx.from?.username,
          chatType: ctx.chat?.type,
        },
      },
    };

    try {
      await this.onUserMessageHandler(inbound);
      await this.flushPendingPartial();
    } finally {
      this.clearPendingTimer();
      this.clearActiveReplyState();
    }
  }

  private async editActiveMessage(content: string): Promise<void> {
    if (!this.bot || this.activeChatId === null || this.activeMessageId === null) {
      return;
    }
    if (content === this.activeText) {
      return;
    }

    try {
      await this.bot.api.editMessageText(this.activeChatId, this.activeMessageId, content);
      this.activeText = content;
      this.lastEditAt = Date.now();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const unchanged = message.includes("message is not modified");
      if (!unchanged) {
        this.platformLogger.warn({ error }, "Failed to edit Telegram message");
      }
    }
  }

  private schedulePartialFlush(delayMs: number): void {
    if (this.pendingTimer) {
      return;
    }

    const delay = Math.max(25, delayMs);
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null;
      void this.flushPendingPartial();
    }, delay);
  }

  private async flushPendingPartial(): Promise<void> {
    if (!this.pendingPartial) {
      return;
    }

    const text = this.pendingPartial;
    this.pendingPartial = null;
    await this.editActiveMessage(text);
  }

  private clearPendingTimer(): void {
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
  }

  private clearActiveReplyState(): void {
    this.activeChatId = null;
    this.activeMessageId = null;
    this.activeText = "";
    this.pendingPartial = null;
    this.lastEditAt = 0;
  }

  private parseChatId(value: string): number | null {
    const parsed = Number(value);
    if (!Number.isInteger(parsed)) {
      return null;
    }
    return parsed;
  }
}
