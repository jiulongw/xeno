import { createReadStream } from "node:fs";
import { basename, extname } from "node:path";
import { Bot, GrammyError, HttpError, InputFile, type Context } from "grammy";

import { logger } from "../../logger";
import type { Attachment, AttachmentType } from "../../media";
import { inferAttachmentType, saveMedia } from "../../media";
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
    supportedMediaTypes: ["image", "video", "audio", "document", "animation", "sticker"],
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

      this.enqueueInbound(async () => {
        await this.handleIncomingText(ctx, text);
      });
    });

    bot.on("message:photo", (ctx) => {
      this.enqueueInbound(async () => {
        const message = ctx.message;
        const variants = message.photo;
        const photo = variants[variants.length - 1];
        if (!photo) {
          return;
        }

        const attachment = await this.createAttachmentFromTelegramFile({
          fileId: photo.file_id,
          type: "image",
          mimeType: "image/jpeg",
          caption: message.caption,
          size: photo.file_size,
          filePathHint: "photo.jpg",
        });
        await this.handleIncomingMedia(ctx, message.caption ?? "", [attachment]);
      });
    });

    bot.on("message:document", (ctx) => {
      this.enqueueInbound(async () => {
        const message = ctx.message;
        const document = message.document;
        const attachment = await this.createAttachmentFromTelegramFile({
          fileId: document.file_id,
          type: inferAttachmentType(document.mime_type ?? ""),
          mimeType: document.mime_type,
          fileName: document.file_name,
          caption: message.caption,
          size: document.file_size,
        });
        await this.handleIncomingMedia(ctx, message.caption ?? "", [attachment]);
      });
    });

    bot.on("message:video", (ctx) => {
      this.enqueueInbound(async () => {
        const message = ctx.message;
        const video = message.video;
        const attachment = await this.createAttachmentFromTelegramFile({
          fileId: video.file_id,
          type: "video",
          mimeType: video.mime_type,
          caption: message.caption,
          size: video.file_size,
          filePathHint: "video.mp4",
        });
        await this.handleIncomingMedia(ctx, message.caption ?? "", [attachment]);
      });
    });

    bot.on("message:audio", (ctx) => {
      this.enqueueInbound(async () => {
        const message = ctx.message;
        const audio = message.audio;
        const attachment = await this.createAttachmentFromTelegramFile({
          fileId: audio.file_id,
          type: "audio",
          mimeType: audio.mime_type,
          fileName: audio.file_name,
          caption: message.caption,
          size: audio.file_size,
        });
        await this.handleIncomingMedia(ctx, message.caption ?? "", [attachment]);
      });
    });

    bot.on("message:voice", (ctx) => {
      this.enqueueInbound(async () => {
        const message = ctx.message;
        const voice = message.voice;
        const attachment = await this.createAttachmentFromTelegramFile({
          fileId: voice.file_id,
          type: "audio",
          mimeType: voice.mime_type ?? "audio/ogg",
          caption: message.caption,
          size: voice.file_size,
          filePathHint: "voice.ogg",
        });
        await this.handleIncomingMedia(ctx, message.caption ?? "", [attachment]);
      });
    });

    bot.on("message:animation", (ctx) => {
      this.enqueueInbound(async () => {
        const message = ctx.message;
        const animation = message.animation;
        const attachment = await this.createAttachmentFromTelegramFile({
          fileId: animation.file_id,
          type: "animation",
          mimeType: animation.mime_type,
          fileName: animation.file_name,
          caption: message.caption,
          size: animation.file_size,
          filePathHint: "animation.gif",
        });
        await this.handleIncomingMedia(ctx, message.caption ?? "", [attachment]);
      });
    });

    bot.on("message:sticker", (ctx) => {
      this.enqueueInbound(async () => {
        const message = ctx.message;
        const sticker = message.sticker;
        const fileName = sticker.set_name
          ? `${sticker.set_name}-${sticker.file_unique_id}`
          : `sticker-${sticker.file_unique_id}`;
        const mimeType = sticker.is_video
          ? "video/webm"
          : sticker.is_animated
            ? "application/x-tgsticker"
            : "image/webp";

        const attachment = await this.createAttachmentFromTelegramFile({
          fileId: sticker.file_id,
          type: "sticker",
          mimeType,
          fileName,
          size: sticker.file_size,
          filePathHint: sticker.is_video ? "sticker.webm" : "sticker.webp",
        });
        await this.handleIncomingMedia(ctx, "", [attachment]);
      });
    });

    try {
      await bot.start();
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
        await this.sendAttachments(targetChatId, options.attachments);
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
      if (!isPartial) {
        await this.sendAttachments(this.activeChatId, options?.attachments);
      }
      return;
    }

    if (!isPartial) {
      this.pendingPartial = null;
      this.clearPendingTimer();
      await this.editActiveMessage(normalized);
      await this.sendAttachments(this.activeChatId, options?.attachments);
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

  private enqueueInbound(task: () => Promise<void>): void {
    this.inboundQueue = this.inboundQueue.then(task).catch((error) => {
      this.platformLogger.error({ error }, "Telegram message handling failed");
    });
  }

  private async handleIncomingText(ctx: Context, text: string): Promise<void> {
    await this.handleIncomingMedia(ctx, text, []);
  }

  private async handleIncomingMedia(
    ctx: Context,
    text: string,
    attachments: Attachment[],
  ): Promise<void> {
    this.activeChatId = ctx.chat?.id ?? null;
    this.activeMessageId = null;
    this.activeText = "";
    this.pendingPartial = null;
    this.clearPendingTimer();
    this.lastEditAt = 0;

    const trimmedText = text.trim();
    const content = trimmedText || "User sent one or more attachments.";

    const inbound: ChatInboundMessage = {
      content,
      context: {
        type: "telegram",
        userId: ctx.from ? String(ctx.from.id) : undefined,
        channelId: this.activeChatId !== null ? String(this.activeChatId) : undefined,
        metadata: {
          username: ctx.from?.username,
          chatType: ctx.chat?.type,
        },
      },
      attachments,
    };

    try {
      await this.onUserMessageHandler(inbound);
      await this.flushPendingPartial();
    } finally {
      this.clearPendingTimer();
      this.clearActiveReplyState();
    }
  }

  private async createAttachmentFromTelegramFile({
    fileId,
    type,
    mimeType,
    fileName,
    caption,
    size,
    filePathHint,
  }: {
    fileId: string;
    type: AttachmentType;
    mimeType?: string;
    fileName?: string;
    caption?: string;
    size?: number;
    filePathHint?: string;
  }): Promise<Attachment> {
    const downloaded = await this.downloadTelegramFile(fileId);
    const extension = inferFileExtension({
      mimeType,
      fileName,
      filePath: downloaded.filePath ?? filePathHint,
      fallbackType: type,
    });

    const mediaPath = await saveMedia(this.home, downloaded.data, extension, "received");
    const resolvedFileName = fileName?.trim() || basename(downloaded.filePath ?? mediaPath);

    return {
      type,
      path: mediaPath,
      mimeType,
      fileName: resolvedFileName,
      caption: caption?.trim() || undefined,
      size,
    };
  }

  private async downloadTelegramFile(
    fileId: string,
  ): Promise<{ data: Buffer; filePath: string | undefined }> {
    if (!this.bot) {
      throw new Error("Telegram bot is not initialized.");
    }

    const file = await this.bot.api.getFile(fileId);
    if (!file.file_path) {
      throw new Error(`Telegram file path missing for file ID ${fileId}.`);
    }

    const url = `https://api.telegram.org/file/bot${this.token}/${file.file_path}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to download Telegram file (${response.status}).`);
    }

    const data = Buffer.from(await response.arrayBuffer());
    return {
      data,
      filePath: file.file_path,
    };
  }

  private async sendAttachments(chatId: number, attachments?: Attachment[]): Promise<void> {
    if (!this.bot || !attachments || attachments.length === 0) {
      return;
    }

    for (const attachment of attachments) {
      const inputFile = new InputFile(createReadStream(attachment.path), attachment.fileName);
      const caption = attachment.caption?.trim() || undefined;

      try {
        switch (attachment.type) {
          case "image": {
            await this.bot.api.sendPhoto(chatId, inputFile, caption ? { caption } : undefined);
            break;
          }
          case "video": {
            await this.bot.api.sendVideo(chatId, inputFile, caption ? { caption } : undefined);
            break;
          }
          case "audio": {
            await this.bot.api.sendAudio(chatId, inputFile, caption ? { caption } : undefined);
            break;
          }
          case "document": {
            await this.bot.api.sendDocument(chatId, inputFile, caption ? { caption } : undefined);
            break;
          }
          case "animation": {
            await this.bot.api.sendAnimation(chatId, inputFile, caption ? { caption } : undefined);
            break;
          }
          case "sticker": {
            await this.bot.api.sendSticker(chatId, inputFile);
            break;
          }
        }
      } catch (error) {
        this.platformLogger.warn({ error, attachment }, "Failed to send Telegram attachment");
      }
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

function inferFileExtension({
  mimeType,
  fileName,
  filePath,
  fallbackType,
}: {
  mimeType?: string;
  fileName?: string;
  filePath?: string;
  fallbackType: AttachmentType;
}): string {
  const extensionFromName = extname(fileName ?? "")
    .replace(/^\./, "")
    .trim();
  if (extensionFromName) {
    return extensionFromName;
  }

  const extensionFromPath = extname(filePath ?? "")
    .replace(/^\./, "")
    .trim();
  if (extensionFromPath) {
    return extensionFromPath;
  }

  const normalizedMime = mimeType?.toLowerCase();
  if (normalizedMime) {
    const mapped = MIME_EXTENSION_MAP[normalizedMime];
    if (mapped) {
      return mapped;
    }

    const parts = normalizedMime.split("/");
    const subtype = parts[1];
    if (subtype) {
      return subtype.replace(/[^a-z0-9]+/g, "") || defaultExtensionForType(fallbackType);
    }
  }

  return defaultExtensionForType(fallbackType);
}

function defaultExtensionForType(type: AttachmentType): string {
  switch (type) {
    case "image":
      return "jpg";
    case "video":
      return "mp4";
    case "audio":
      return "ogg";
    case "animation":
      return "gif";
    case "sticker":
      return "webp";
    case "document":
      return "bin";
  }
}

const MIME_EXTENSION_MAP: Record<string, string> = {
  "application/pdf": "pdf",
  "application/x-tgsticker": "tgs",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/webm": "webm",
};
