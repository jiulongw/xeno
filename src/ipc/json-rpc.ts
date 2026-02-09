import type { Socket } from "node:net";

import { logger } from "../logger";

type JsonRpcId = string | number;

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
};

type JsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
};

type JsonRpcSuccessResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
};

type JsonRpcErrorResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
};

type JsonRpcIncoming =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcSuccessResponse
  | JsonRpcErrorResponse;

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export type JsonRpcRequestHandler = (method: string, params: unknown) => Promise<unknown> | unknown;
export type JsonRpcNotificationHandler = (method: string, params: unknown) => void | Promise<void>;
export type JsonRpcCloseHandler = () => void;

export class JsonRpcPeer {
  private readonly socket: Socket;
  private readonly peerLogger;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();

  private requestHandler: JsonRpcRequestHandler | null = null;
  private notificationHandler: JsonRpcNotificationHandler | null = null;
  private closeHandler: JsonRpcCloseHandler | null = null;

  private nextRequestId = 1;
  private buffer = "";

  constructor(socket: Socket, peerName: string) {
    this.socket = socket;
    this.peerLogger = logger.child({ component: "json-rpc", peer: peerName });

    this.socket.setEncoding("utf8");
    this.socket.on("data", (chunk: string) => {
      this.handleData(chunk);
    });
    this.socket.on("close", () => {
      this.rejectAllPending(new Error("JSON-RPC connection closed"));
      this.closeHandler?.();
    });
    this.socket.on("error", (error) => {
      this.peerLogger.warn({ error }, "JSON-RPC socket error");
      this.rejectAllPending(new Error("JSON-RPC socket error"));
    });
  }

  setRequestHandler(handler: JsonRpcRequestHandler): void {
    this.requestHandler = handler;
  }

  setNotificationHandler(handler: JsonRpcNotificationHandler): void {
    this.notificationHandler = handler;
  }

  setCloseHandler(handler: JsonRpcCloseHandler): void {
    this.closeHandler = handler;
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextRequestId;
    this.nextRequestId += 1;

    const payload: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    const response = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });

    this.send(payload);
    return response;
  }

  notify(method: string, params?: unknown): void {
    const payload: JsonRpcNotification = {
      jsonrpc: "2.0",
      method,
      params,
    };
    this.send(payload);
  }

  close(): void {
    if (!this.socket.destroyed) {
      this.socket.end();
    }
  }

  private handleData(chunk: string): void {
    this.buffer += chunk;

    while (true) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex < 0) {
        break;
      }

      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (!line) {
        continue;
      }

      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let payload: unknown;
    try {
      payload = JSON.parse(line);
    } catch {
      this.peerLogger.warn({ line }, "Invalid JSON-RPC payload");
      return;
    }

    const incoming = payload as Partial<JsonRpcIncoming>;
    if (incoming.jsonrpc !== "2.0") {
      this.peerLogger.warn({ payload }, "Unsupported JSON-RPC version");
      return;
    }

    if ("method" in incoming && typeof incoming.method === "string") {
      if ("id" in incoming && incoming.id !== undefined && incoming.id !== null) {
        void this.handleRequest(incoming as JsonRpcRequest);
        return;
      }

      void this.handleNotification(incoming as JsonRpcNotification);
      return;
    }

    if ("id" in incoming && incoming.id !== undefined && incoming.id !== null) {
      this.handleResponse(incoming as JsonRpcSuccessResponse | JsonRpcErrorResponse);
      return;
    }

    this.peerLogger.warn({ payload }, "Unknown JSON-RPC message shape");
  }

  private async handleRequest(request: JsonRpcRequest): Promise<void> {
    if (!this.requestHandler) {
      this.send({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32601, message: `Method not found: ${request.method}` },
      });
      return;
    }

    try {
      const result = await this.requestHandler(request.method, request.params);
      this.send({
        jsonrpc: "2.0",
        id: request.id,
        result,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.send({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32000, message },
      });
    }
  }

  private async handleNotification(notification: JsonRpcNotification): Promise<void> {
    if (!this.notificationHandler) {
      return;
    }

    try {
      await this.notificationHandler(notification.method, notification.params);
    } catch (error) {
      this.peerLogger.warn({ error, method: notification.method }, "Notification handler failed");
    }
  }

  private handleResponse(response: JsonRpcSuccessResponse | JsonRpcErrorResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) {
      return;
    }
    this.pending.delete(response.id);

    if ("error" in response && response.error) {
      pending.reject(new Error(response.error.message));
      return;
    }

    if ("result" in response) {
      pending.resolve(response.result);
    } else {
      pending.reject(new Error("Missing JSON-RPC result"));
    }
  }

  private send(payload: JsonRpcIncoming): void {
    if (this.socket.destroyed) {
      return;
    }
    this.socket.write(`${JSON.stringify(payload)}\n`);
  }

  private rejectAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}
