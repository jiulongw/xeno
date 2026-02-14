import type { Attachment, AttachmentType } from "../media";

export type PlatformType = "console" | "telegram" | "discord" | "slack";

export interface PlatformContext {
  type: PlatformType;
  userId?: string;
  channelId?: string;
  metadata?: Record<string, unknown>;
}

export interface PlatformCapabilities {
  supportsStreaming: boolean;
  supportsMarkdownTables: boolean;
  supportedMediaTypes?: AttachmentType[];
}

export interface OutboundMessageTarget {
  platform: PlatformType;
  channelId: string;
}

export interface OutboundMessageOptions {
  reason: "response" | "proactive";
  target?: OutboundMessageTarget;
  attachments?: Attachment[];
  suppressText?: boolean;
}

export interface ChatInboundMessage {
  content: string;
  context: PlatformContext;
  attachments?: Attachment[];
}

export type UserMessageHandler = (message: ChatInboundMessage) => Promise<void> | void;
export type AbortRequestHandler = () => void;

export interface ChatService {
  readonly type: PlatformType;
  readonly capabilities: PlatformCapabilities;

  start(): Promise<void>;
  stop(): Promise<void>;
  startTyping?(): Promise<void>;
  stopTyping?(): Promise<void>;

  onUserMessage(handler: UserMessageHandler): void;
  onAbortRequest?(handler: AbortRequestHandler): void;

  sendMessage(content: string, isPartial: boolean, options?: OutboundMessageOptions): Promise<void>;
  sendStats(stats: string): Promise<void>;
}

export interface ChatConfig {
  home: string;
  enabledPlatforms: PlatformType[];
}
