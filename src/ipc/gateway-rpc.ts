import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { createServer, createConnection, type Server, type Socket } from "node:net";
import { randomUUID } from "node:crypto";

import { logger } from "../logger";
import type { Gateway } from "../gateway";
import type { ConversationTurn } from "../agent";
import type { ChatInboundMessage, PlatformCapabilities, PlatformContext } from "../chat/service";
import type { Attachment, AttachmentType } from "../media";
import { JsonRpcPeer } from "./json-rpc";
import { getGatewaySocketPath, isSocketPathActive } from "./socket";

export interface GatewaySessionSnapshot {
  sessionId: string | null;
  history: ConversationTurn[];
}

type GatewayQueryParams = {
  requestId: string;
  content: string;
  context: PlatformContext;
  attachments?: Attachment[];
};

type GatewayAbortParams = {
  requestId?: string;
};

type GatewayHeartbeatParams = Record<string, never>;
type GatewayNewSessionParams = Record<string, never>;

export interface GatewayTaskTriggerResponse {
  ok: boolean;
  message: string;
  result?: string;
  durationMs?: number;
}

type StreamNotification = {
  requestId: string;
  content: string;
  isPartial: boolean;
  attachments?: Attachment[];
};

type StatsNotification = {
  requestId: string;
  stats: string;
};

type DoneNotification = {
  requestId: string;
};

type ErrorNotification = {
  requestId: string;
  error: string;
};

export interface GatewayRpcServerOptions {
  home: string;
  gateway: Gateway;
  runHeartbeat?: () => Promise<GatewayTaskTriggerResponse>;
  runNewSession?: () => Promise<GatewayTaskTriggerResponse>;
}

export class GatewayRpcServer {
  private readonly home: string;
  private readonly gateway: Gateway;
  private readonly runHeartbeat: (() => Promise<GatewayTaskTriggerResponse>) | null;
  private readonly runNewSession: (() => Promise<GatewayTaskTriggerResponse>) | null;
  private readonly socketPath: string;
  private readonly rpcLogger;

  private server: Server | null = null;
  private peers = new Set<JsonRpcPeer>();

  constructor(options: GatewayRpcServerOptions) {
    this.home = options.home;
    this.gateway = options.gateway;
    this.runHeartbeat = options.runHeartbeat ?? null;
    this.runNewSession = options.runNewSession ?? null;
    this.socketPath = getGatewaySocketPath(options.home);
    this.rpcLogger = logger.child({ component: "gateway-rpc", home: this.home });
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    await mkdir(dirname(this.socketPath), { recursive: true });
    await this.ensureSocketIsAvailable();

    const server = createServer((socket) => {
      this.handleConnection(socket);
    });
    this.server = server;

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.socketPath, () => {
          server.off("error", reject);
          resolve();
        });
      });
    } catch (error) {
      this.server = null;
      server.close();
      throw error;
    }

    this.rpcLogger.info({ socketPath: this.socketPath }, "Gateway RPC server started");
  }

  async stop(): Promise<void> {
    for (const peer of this.peers) {
      peer.close();
    }
    this.peers.clear();

    if (this.server) {
      const server = this.server;
      this.server = null;

      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }

    await this.removeSocketIfPresent();
    this.rpcLogger.info("Gateway RPC server stopped");
  }

  private handleConnection(socket: Socket): void {
    const peer = new JsonRpcPeer(socket, `rpc-server:${socket.remoteAddress ?? "local"}`);
    this.peers.add(peer);

    peer.setCloseHandler(() => {
      this.peers.delete(peer);
    });

    peer.setRequestHandler(async (method, params) => {
      if (method === "gateway.initialize") {
        const snapshot: GatewaySessionSnapshot = {
          sessionId: this.gateway.getSessionId(),
          history: await this.gateway.getConversationHistory(),
        };
        return snapshot;
      }

      if (method === "gateway.query") {
        const parsed = this.parseQueryParams(params);
        void this.handleQuery(peer, parsed);
        return { accepted: true };
      }

      if (method === "gateway.abort") {
        this.parseAbortParams(params);
        this.gateway.requestAbort();
        return { ok: true };
      }

      if (method === "gateway.heartbeat") {
        this.parseHeartbeatParams(params);
        if (!this.runHeartbeat) {
          return {
            ok: false,
            message: "Heartbeat trigger is not available in this runtime.",
          } satisfies GatewayTaskTriggerResponse;
        }

        return this.runHeartbeat();
      }

      if (method === "gateway.new_session") {
        this.parseNewSessionParams(params);
        if (!this.runNewSession) {
          return {
            ok: false,
            message: "New session trigger is not available in this runtime.",
          } satisfies GatewayTaskTriggerResponse;
        }

        return this.runNewSession();
      }

      throw new Error(`Method not found: ${method}`);
    });
  }

  private async handleQuery(peer: JsonRpcPeer, params: GatewayQueryParams): Promise<void> {
    const capabilities = this.capabilitiesForContext(params.context);
    const serviceType = params.context.type;

    const responder = {
      type: serviceType,
      capabilities,
      sendMessage: async (
        content: string,
        isPartial: boolean,
        options?: { attachments?: Attachment[] },
      ) => {
        peer.notify("gateway.stream", {
          requestId: params.requestId,
          content,
          isPartial,
          attachments: !isPartial ? options?.attachments : undefined,
        } satisfies StreamNotification);

        if (!isPartial) {
          peer.notify("gateway.done", { requestId: params.requestId } satisfies DoneNotification);
        }
      },
      sendStats: async (stats: string) => {
        peer.notify("gateway.stats", {
          requestId: params.requestId,
          stats,
        } satisfies StatsNotification);
      },
    };

    const inbound: ChatInboundMessage = {
      content: params.content,
      context: params.context,
      attachments: params.attachments,
    };

    try {
      await this.gateway.submitMessage(responder, inbound);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      peer.notify("gateway.error", {
        requestId: params.requestId,
        error: message,
      } satisfies ErrorNotification);
      peer.notify("gateway.done", { requestId: params.requestId } satisfies DoneNotification);
    }
  }

  private capabilitiesForContext(context: PlatformContext): PlatformCapabilities {
    if (context.type === "telegram" || context.type === "discord" || context.type === "slack") {
      return {
        supportsStreaming: true,
        supportsMarkdownTables: false,
      };
    }

    return {
      supportsStreaming: true,
      supportsMarkdownTables: true,
    };
  }

  private parseQueryParams(value: unknown): GatewayQueryParams {
    if (!value || typeof value !== "object") {
      throw new Error("Invalid query params.");
    }

    const record = value as Record<string, unknown>;
    const requestId = record.requestId;
    const content = record.content;
    const context = record.context;
    const attachments = parseAttachments(record.attachments, "query");

    if (typeof requestId !== "string" || requestId.length === 0) {
      throw new Error("Invalid query requestId.");
    }
    if (typeof content !== "string" || content.trim().length === 0) {
      throw new Error("Invalid query content.");
    }
    if (!context || typeof context !== "object") {
      throw new Error("Invalid query context.");
    }

    const contextRecord = context as Record<string, unknown>;
    const type = contextRecord.type;
    if (type !== "console" && type !== "telegram" && type !== "discord" && type !== "slack") {
      throw new Error("Invalid query context type.");
    }

    return {
      requestId,
      content,
      attachments,
      context: {
        type,
        userId: typeof contextRecord.userId === "string" ? contextRecord.userId : undefined,
        channelId:
          typeof contextRecord.channelId === "string" ? contextRecord.channelId : undefined,
        metadata:
          contextRecord.metadata && typeof contextRecord.metadata === "object"
            ? (contextRecord.metadata as Record<string, unknown>)
            : undefined,
      },
    };
  }

  private parseAbortParams(value: unknown): GatewayAbortParams {
    if (value === undefined || value === null) {
      return {};
    }

    if (typeof value !== "object") {
      throw new Error("Invalid abort params.");
    }

    const record = value as Record<string, unknown>;
    return {
      requestId: typeof record.requestId === "string" ? record.requestId : undefined,
    };
  }

  private parseHeartbeatParams(value: unknown): GatewayHeartbeatParams {
    if (value === undefined || value === null) {
      return {};
    }

    if (typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Invalid heartbeat params.");
    }

    return {};
  }

  private parseNewSessionParams(value: unknown): GatewayNewSessionParams {
    if (value === undefined || value === null) {
      return {};
    }

    if (typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Invalid new_session params.");
    }

    return {};
  }

  private async ensureSocketIsAvailable(): Promise<void> {
    if (!existsSync(this.socketPath)) {
      return;
    }

    const active = await isSocketPathActive(this.socketPath);
    if (active) {
      throw new Error(
        `Gateway RPC socket already in use at ${this.socketPath}. Is another serve process running?`,
      );
    }

    await this.removeSocketIfPresent();
  }

  private async removeSocketIfPresent(): Promise<void> {
    if (!existsSync(this.socketPath)) {
      return;
    }

    await rm(this.socketPath, { force: true });
  }
}

export interface GatewayRpcQueryHandlers {
  onStream: (content: string, isPartial: boolean, attachments?: Attachment[]) => void;
  onStats: (stats: string) => void;
}

type PendingQuery = {
  handlers: GatewayRpcQueryHandlers;
  resolve: () => void;
  reject: (error: Error) => void;
};

export class GatewayRpcClient {
  private readonly home: string;
  private readonly socketPath: string;
  private readonly clientLogger;

  private socket: Socket | null = null;
  private peer: JsonRpcPeer | null = null;
  private pendingQueries = new Map<string, PendingQuery>();
  private disconnectedHandler: (() => void) | null = null;

  constructor(home: string) {
    this.home = home;
    this.socketPath = getGatewaySocketPath(home);
    this.clientLogger = logger.child({ component: "gateway-rpc-client", home: this.home });
  }

  setDisconnectedHandler(handler: () => void): void {
    this.disconnectedHandler = handler;
  }

  async connect(): Promise<void> {
    if (this.peer) {
      return;
    }

    const socket = await connectSocket(this.socketPath);
    this.socket = socket;

    const peer = new JsonRpcPeer(socket, "rpc-client");
    this.peer = peer;
    peer.setCloseHandler(() => {
      this.rejectAllQueries(new Error("Disconnected from gateway"));
      this.disconnectedHandler?.();
    });

    peer.setNotificationHandler(async (method, params) => {
      this.handleNotification(method, params);
    });
  }

  async initialize(): Promise<GatewaySessionSnapshot> {
    const peer = this.requirePeer();
    const result = await peer.request("gateway.initialize");
    return this.parseSnapshot(result);
  }

  async query(
    content: string,
    context: PlatformContext,
    handlers: GatewayRpcQueryHandlers,
    attachments?: Attachment[],
  ): Promise<void> {
    const peer = this.requirePeer();
    const requestId = randomUUID();

    const completion = new Promise<void>((resolve, reject) => {
      this.pendingQueries.set(requestId, { handlers, resolve, reject });
    });

    try {
      await peer.request("gateway.query", {
        requestId,
        content,
        context,
        attachments,
      } satisfies GatewayQueryParams);
      await completion;
    } catch (error) {
      this.pendingQueries.delete(requestId);
      throw error;
    } finally {
      this.pendingQueries.delete(requestId);
    }
  }

  async abort(): Promise<void> {
    const peer = this.requirePeer();
    await peer.request("gateway.abort", {});
  }

  async heartbeat(): Promise<GatewayTaskTriggerResponse> {
    const peer = this.requirePeer();
    const result = await peer.request("gateway.heartbeat", {});
    return this.parseTaskTriggerResponse(result, "heartbeat");
  }

  async newSession(): Promise<GatewayTaskTriggerResponse> {
    const peer = this.requirePeer();
    const result = await peer.request("gateway.new_session", {});
    return this.parseTaskTriggerResponse(result, "new_session");
  }

  close(): void {
    this.peer?.close();
    if (this.socket && !this.socket.destroyed) {
      this.socket.end();
    }
    this.peer = null;
    this.socket = null;
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === "gateway.stream") {
      const parsed = this.parseStream(params);
      const pending = this.pendingQueries.get(parsed.requestId);
      if (!pending) {
        return;
      }
      pending.handlers.onStream(parsed.content, parsed.isPartial, parsed.attachments);
      return;
    }

    if (method === "gateway.stats") {
      const parsed = this.parseStats(params);
      const pending = this.pendingQueries.get(parsed.requestId);
      if (!pending) {
        return;
      }
      pending.handlers.onStats(parsed.stats);
      return;
    }

    if (method === "gateway.done") {
      const parsed = this.parseDone(params);
      const pending = this.pendingQueries.get(parsed.requestId);
      if (!pending) {
        return;
      }
      pending.resolve();
      return;
    }

    if (method === "gateway.error") {
      const parsed = this.parseError(params);
      const pending = this.pendingQueries.get(parsed.requestId);
      if (!pending) {
        return;
      }
      pending.reject(new Error(parsed.error));
      return;
    }

    this.clientLogger.debug({ method }, "Unknown gateway notification");
  }

  private parseSnapshot(value: unknown): GatewaySessionSnapshot {
    if (!value || typeof value !== "object") {
      throw new Error("Invalid gateway initialize response.");
    }

    const record = value as Record<string, unknown>;
    const sessionId = record.sessionId;
    const history = record.history;

    if (sessionId !== null && typeof sessionId !== "string") {
      throw new Error("Invalid gateway session id.");
    }
    if (!Array.isArray(history)) {
      throw new Error("Invalid gateway history.");
    }

    const parsedHistory: ConversationTurn[] = history
      .map((entry) => {
        if (!entry || typeof entry !== "object") {
          return null;
        }
        const turn = entry as Record<string, unknown>;
        if (
          (turn.role !== "user" && turn.role !== "assistant") ||
          typeof turn.content !== "string"
        ) {
          return null;
        }
        return {
          role: turn.role,
          content: turn.content,
        } satisfies ConversationTurn;
      })
      .filter((turn): turn is ConversationTurn => turn !== null);

    return {
      sessionId: sessionId ?? null,
      history: parsedHistory,
    };
  }

  private parseStream(value: unknown): StreamNotification {
    if (!value || typeof value !== "object") {
      throw new Error("Invalid stream notification.");
    }
    const record = value as Record<string, unknown>;
    if (
      typeof record.requestId !== "string" ||
      typeof record.content !== "string" ||
      typeof record.isPartial !== "boolean"
    ) {
      throw new Error("Invalid stream notification payload.");
    }

    const attachments = parseAttachments(record.attachments, "stream");
    return {
      requestId: record.requestId,
      content: record.content,
      isPartial: record.isPartial,
      attachments,
    };
  }

  private parseStats(value: unknown): StatsNotification {
    if (!value || typeof value !== "object") {
      throw new Error("Invalid stats notification.");
    }
    const record = value as Record<string, unknown>;
    if (typeof record.requestId !== "string" || typeof record.stats !== "string") {
      throw new Error("Invalid stats notification payload.");
    }
    return {
      requestId: record.requestId,
      stats: record.stats,
    };
  }

  private parseDone(value: unknown): DoneNotification {
    if (!value || typeof value !== "object") {
      throw new Error("Invalid done notification.");
    }
    const record = value as Record<string, unknown>;
    if (typeof record.requestId !== "string") {
      throw new Error("Invalid done notification payload.");
    }
    return {
      requestId: record.requestId,
    };
  }

  private parseError(value: unknown): ErrorNotification {
    if (!value || typeof value !== "object") {
      throw new Error("Invalid error notification.");
    }
    const record = value as Record<string, unknown>;
    if (typeof record.requestId !== "string" || typeof record.error !== "string") {
      throw new Error("Invalid error notification payload.");
    }
    return {
      requestId: record.requestId,
      error: record.error,
    };
  }

  private parseTaskTriggerResponse(
    value: unknown,
    trigger: "heartbeat" | "new_session",
  ): GatewayTaskTriggerResponse {
    if (!value || typeof value !== "object") {
      throw new Error(`Invalid ${trigger} response.`);
    }

    const record = value as Record<string, unknown>;
    if (typeof record.ok !== "boolean" || typeof record.message !== "string") {
      throw new Error(`Invalid ${trigger} response payload.`);
    }

    return {
      ok: record.ok,
      message: record.message,
      result: typeof record.result === "string" ? record.result : undefined,
      durationMs: typeof record.durationMs === "number" ? record.durationMs : undefined,
    };
  }

  private rejectAllQueries(error: Error): void {
    for (const pending of this.pendingQueries.values()) {
      pending.reject(error);
    }
    this.pendingQueries.clear();
  }

  private requirePeer(): JsonRpcPeer {
    if (!this.peer) {
      throw new Error("Not connected to gateway RPC.");
    }
    return this.peer;
  }
}

const ATTACHMENT_TYPES: readonly AttachmentType[] = [
  "image",
  "video",
  "audio",
  "voice",
  "document",
  "animation",
  "sticker",
];

function isAttachmentType(value: unknown): value is AttachmentType {
  return typeof value === "string" && ATTACHMENT_TYPES.includes(value as AttachmentType);
}

function parseAttachments(value: unknown, source: "query" | "stream"): Attachment[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`Invalid ${source} attachments payload.`);
  }

  return value.map((entry) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`Invalid ${source} attachment.`);
    }

    const record = entry as Record<string, unknown>;
    const type = record.type;
    const path = record.path;
    if (!isAttachmentType(type) || typeof path !== "string" || path.trim().length === 0) {
      throw new Error(`Invalid ${source} attachment payload.`);
    }

    return {
      type,
      path,
      mimeType: typeof record.mimeType === "string" ? record.mimeType : undefined,
      fileName: typeof record.fileName === "string" ? record.fileName : undefined,
      caption: typeof record.caption === "string" ? record.caption : undefined,
      size: typeof record.size === "number" ? record.size : undefined,
    } satisfies Attachment;
  });
}

async function connectSocket(socketPath: string): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.once("connect", () => {
      resolve(socket);
    });
    socket.once("error", (error) => {
      reject(error);
    });
  });
}
