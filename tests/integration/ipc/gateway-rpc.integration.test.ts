import { describe, expect, test } from "bun:test";
import { Gateway } from "../../../src/gateway";
import { GatewayRpcClient, GatewayRpcServer } from "../../../src/ipc/gateway-rpc";
import { EchoMockAgent } from "../../helpers/echo-mock-agent";

type NotificationRecord = {
  method: string;
  params: unknown;
};

function asServerInternals(server: GatewayRpcServer): {
  handleQuery: (
    peer: { notify: (method: string, params?: unknown) => void },
    params: {
      requestId: string;
      content: string;
      context: {
        type: "console" | "telegram" | "discord" | "slack";
        metadata?: Record<string, unknown>;
      };
    },
  ) => Promise<void>;
  parseQueryParams: (value: unknown) => unknown;
} {
  return server as unknown as {
    handleQuery: (
      peer: { notify: (method: string, params?: unknown) => void },
      params: {
        requestId: string;
        content: string;
        context: {
          type: "console" | "telegram" | "discord" | "slack";
          metadata?: Record<string, unknown>;
        };
      },
    ) => Promise<void>;
    parseQueryParams: (value: unknown) => unknown;
  };
}

function asClientInternals(client: GatewayRpcClient): {
  peer: { request: (method: string, params?: unknown) => Promise<unknown> } | null;
  handleNotification: (method: string, params: unknown) => void;
} {
  return client as unknown as {
    peer: { request: (method: string, params?: unknown) => Promise<unknown> } | null;
    handleNotification: (method: string, params: unknown) => void;
  };
}

describe("Gateway RPC integration", () => {
  test("GatewayRpcServer handleQuery forwards gateway stream/stats/done notifications", async () => {
    const agent = new EchoMockAgent();
    const gateway = new Gateway({
      home: "/tmp/test-home",
      agent,
      services: [],
    });
    const server = new GatewayRpcServer({
      home: "/tmp/test-home",
      gateway,
    });
    const notifications: NotificationRecord[] = [];
    const peer = {
      notify: (method: string, params?: unknown) => {
        notifications.push({ method, params });
      },
    };

    await asServerInternals(server).handleQuery(peer, {
      requestId: "req-1",
      content: "echo this",
      context: {
        type: "console",
        metadata: { source: "integration-test" },
      },
    });

    expect(notifications.map((entry) => entry.method)).toEqual([
      "gateway.stats",
      "gateway.stream",
      "gateway.done",
    ]);
    expect(notifications[0]?.params).toMatchObject({
      requestId: "req-1",
    });
    expect(notifications[1]?.params).toMatchObject({
      requestId: "req-1",
      content: "echo this",
      isPartial: false,
    });
    expect(notifications[2]?.params).toMatchObject({
      requestId: "req-1",
    });
  });

  test("GatewayRpcServer parseQueryParams validates malformed payloads", () => {
    const gateway = new Gateway({
      home: "/tmp/test-home",
      agent: new EchoMockAgent(),
      services: [],
    });
    const server = new GatewayRpcServer({
      home: "/tmp/test-home",
      gateway,
    });
    const { parseQueryParams } = asServerInternals(server);

    expect(() =>
      parseQueryParams({ requestId: "", content: "x", context: { type: "console" } }),
    ).toThrow("Invalid query requestId.");
    expect(() =>
      parseQueryParams({
        requestId: "req-1",
        content: "x",
        context: { type: "not-a-platform" },
      }),
    ).toThrow("Invalid query context type.");
  });

  test("GatewayRpcClient handles initialize/query/abort request flow", async () => {
    const client = new GatewayRpcClient("/tmp/test-home");
    const internals = asClientInternals(client);
    const streams: Array<{ content: string; isPartial: boolean }> = [];
    const stats: string[] = [];

    internals.peer = {
      request: async (method: string, params?: unknown) => {
        if (method === "gateway.initialize") {
          return {
            sessionId: "session-1",
            history: [{ role: "user", content: "hello" }],
          };
        }

        if (method === "gateway.abort") {
          return { ok: true };
        }

        if (method === "gateway.heartbeat") {
          return {
            ok: true,
            message: "Heartbeat completed.",
            result: "HEARTBEAT_OK",
            durationMs: 12,
          };
        }

        if (method === "gateway.new_session") {
          return {
            ok: true,
            message: "New session task completed.",
            result: "NEW_SESSION_OK",
            durationMs: 15,
          };
        }

        if (method === "gateway.query") {
          const requestId = (params as { requestId: string }).requestId;
          queueMicrotask(() => {
            internals.handleNotification("gateway.stream", {
              requestId,
              content: "echo",
              isPartial: true,
            });
            internals.handleNotification("gateway.stats", {
              requestId,
              stats: "result=success",
            });
            internals.handleNotification("gateway.stream", {
              requestId,
              content: "echo",
              isPartial: false,
            });
            internals.handleNotification("gateway.done", { requestId });
          });
          return { accepted: true };
        }

        throw new Error(`Unexpected request method: ${method}`);
      },
    };

    const snapshot = await client.initialize();
    expect(snapshot).toEqual({
      sessionId: "session-1",
      history: [{ role: "user", content: "hello" }],
    });

    await client.query(
      "hello",
      { type: "console" },
      {
        onStream: (content, isPartial) => {
          streams.push({ content, isPartial });
        },
        onStats: (value) => {
          stats.push(value);
        },
      },
    );

    expect(streams).toEqual([
      { content: "echo", isPartial: true },
      { content: "echo", isPartial: false },
    ]);
    expect(stats).toEqual(["result=success"]);

    await client.abort();

    const heartbeat = await client.heartbeat();
    expect(heartbeat).toEqual({
      ok: true,
      message: "Heartbeat completed.",
      result: "HEARTBEAT_OK",
      durationMs: 12,
    });

    const newSession = await client.newSession();
    expect(newSession).toEqual({
      ok: true,
      message: "New session task completed.",
      result: "NEW_SESSION_OK",
      durationMs: 15,
    });
  });
});
