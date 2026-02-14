import { describe, expect, test } from "bun:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type {
  ChatInboundMessage,
  ChatService,
  OutboundMessageOptions,
  PlatformCapabilities,
  UserMessageHandler,
  PlatformType,
} from "../../src/chat/service";
import { Gateway } from "../../src/gateway";
import { EchoMockAgent } from "../helpers/echo-mock-agent";

type MessageRecord = {
  content: string;
  isPartial: boolean;
  options?: OutboundMessageOptions;
};

type QueryServiceMock = {
  type: PlatformType;
  capabilities: PlatformCapabilities;
  messages: MessageRecord[];
  stats: string[];
  sendMessage: (
    content: string,
    isPartial: boolean,
    options?: OutboundMessageOptions,
  ) => Promise<void>;
  sendStats: (value: string) => Promise<void>;
  startTyping?: () => Promise<void>;
  stopTyping?: () => Promise<void>;
};

const TELEGRAM_STOP_FOLLOW_UP_PROMPT =
  "The Telegram user intentionally sent /stop to abort the previous response. " +
  "Acknowledge that the previous response was stopped and ask what they want to do next.";

function makeQueryService(type: PlatformType = "rpc"): QueryServiceMock {
  const messages: MessageRecord[] = [];
  const stats: string[] = [];

  return {
    type,
    capabilities: {
      supportsStreaming: true,
      supportsMarkdownTables: true,
    } satisfies PlatformCapabilities,
    messages,
    stats,
    sendMessage: async (content: string, isPartial: boolean, options?: OutboundMessageOptions) => {
      messages.push({ content, isPartial, options });
    },
    sendStats: async (value: string) => {
      stats.push(value);
    },
  };
}

function inbound(
  content: string,
  context: ChatInboundMessage["context"] = {
    type: "rpc",
    metadata: {
      source: "test",
    },
  },
): ChatInboundMessage {
  return {
    content,
    context,
  };
}

describe("Gateway", () => {
  test("sends only final response", async () => {
    const agent = new EchoMockAgent();
    const gateway = new Gateway({
      home: "/tmp/test-home",
      agent,
      services: [],
    });
    const service = makeQueryService();

    await gateway.submitMessage(service, inbound("hello"));

    expect(service.messages).toEqual([
      { content: "hello", isPartial: false, options: { reason: "response" } },
    ]);
    expect(service.stats.length).toBe(1);
    expect(service.stats[0]).toContain("result=success");
    expect(agent.calls.length).toBe(1);
    expect(agent.calls[0]?.options?.platformContext?.type).toBe("rpc");
  });

  test("starts and stops typing around reply query", async () => {
    const agent = new EchoMockAgent({ chunkDelayMs: 25 });
    const gateway = new Gateway({
      home: "/tmp/test-home",
      agent,
      services: [],
    });
    const service = makeQueryService("telegram");
    let starts = 0;
    let stops = 0;
    service.startTyping = async () => {
      starts += 1;
    };
    service.stopTyping = async () => {
      stops += 1;
    };

    await gateway.submitMessage(
      service,
      inbound("hello", {
        type: "telegram",
        channelId: "1001",
      }),
    );

    expect(starts).toBe(1);
    expect(stops).toBe(1);
  });

  test("routes /compact as raw slash command without platform context wrapping", async () => {
    const agent = new EchoMockAgent();
    const gateway = new Gateway({
      home: "/tmp/test-home",
      agent,
      services: [],
    });
    const service = makeQueryService("telegram");

    await gateway.submitMessage(
      service,
      inbound("/compact", {
        type: "telegram",
        channelId: "1001",
      }),
    );

    expect(agent.calls.length).toBe(1);
    expect(agent.calls[0]?.prompt).toBe("/compact");
    expect(agent.calls[0]?.options?.platformContext).toBeUndefined();
    expect(service.messages).toEqual([
      { content: "/compact", isPartial: false, options: { reason: "response" } },
    ]);
  });

  test("sends compact done when /compact returns no text", async () => {
    const agent = new EchoMockAgent({ emitStreamText: false });
    const gateway = new Gateway({
      home: "/tmp/test-home",
      agent,
      services: [],
    });
    const service = makeQueryService("telegram");

    await gateway.submitMessage(
      service,
      inbound("/compact", {
        type: "telegram",
        channelId: "1001",
      }),
    );

    expect(service.messages).toEqual([
      { content: "compact done", isPartial: false, options: { reason: "response" } },
    ]);
  });

  test("routes Telegram /stop to follow-up prompt without platform context wrapping", async () => {
    const agent = new EchoMockAgent();
    const gateway = new Gateway({
      home: "/tmp/test-home",
      agent,
      services: [],
    });
    const service = makeQueryService("telegram");

    await gateway.submitMessage(
      service,
      inbound("/stop", {
        type: "telegram",
        channelId: "1001",
      }),
    );

    expect(agent.calls.length).toBe(1);
    expect(agent.calls[0]?.prompt).toBe(TELEGRAM_STOP_FOLLOW_UP_PROMPT);
    expect(agent.calls[0]?.options?.platformContext).toBeUndefined();
    expect(service.messages).toEqual([
      {
        content: TELEGRAM_STOP_FOLLOW_UP_PROMPT,
        isPartial: false,
        options: { reason: "response" },
      },
    ]);
  });

  test("treats /stop as a normal prompt for non-Telegram platforms", async () => {
    const agent = new EchoMockAgent();
    const gateway = new Gateway({
      home: "/tmp/test-home",
      agent,
      services: [],
    });
    const service = makeQueryService("rpc");

    await gateway.submitMessage(
      service,
      inbound("/stop", {
        type: "rpc",
      }),
    );

    expect(agent.calls.length).toBe(1);
    expect(agent.calls[0]?.prompt).toBe("/stop");
    expect(agent.calls[0]?.options?.platformContext?.type).toBe("rpc");
  });

  test("queues a second request while one is active", async () => {
    const agent = new EchoMockAgent({ chunkDelayMs: 80 });
    const gateway = new Gateway({
      home: "/tmp/test-home",
      agent,
      services: [],
    });

    const firstService = makeQueryService();
    const secondService = makeQueryService();

    const first = gateway.submitMessage(firstService, inbound("slow"));
    await gateway.submitMessage(secondService, inbound("second"));
    await first;

    expect(secondService.messages).toEqual([
      {
        content:
          "Busy with another task right now. I queued your message and will reply when it finishes.",
        isPartial: false,
        options: { reason: "response" },
      },
      { content: "second", isPartial: false, options: { reason: "response" } },
    ]);
  });

  test("aborts active query when Telegram /stop is received while busy", async () => {
    const agent = new EchoMockAgent({ chunkDelayMs: 500 });
    const gateway = new Gateway({
      home: "/tmp/test-home",
      agent,
      services: [],
    });

    const firstService = makeQueryService("telegram");
    const secondService = makeQueryService("telegram");

    const first = gateway.submitMessage(
      firstService,
      inbound("slow", {
        type: "telegram",
        channelId: "1001",
      }),
    );
    await sleep(25);
    await gateway.submitMessage(
      secondService,
      inbound("/stop", {
        type: "telegram",
        channelId: "1001",
      }),
    );
    await first;

    expect(agent.abortCount).toBeGreaterThanOrEqual(1);
    expect(firstService.messages).toEqual([]);
    expect(
      secondService.messages.some(
        (message) =>
          message.content ===
          "Busy with another task right now. I queued your message and will reply when it finishes.",
      ),
    ).toBe(false);
    expect(secondService.messages).toEqual([
      {
        content: TELEGRAM_STOP_FOLLOW_UP_PROMPT,
        isPartial: false,
        options: { reason: "response" },
      },
    ]);
  });

  test("drains queued queries into Telegram /stop follow-up context", async () => {
    const agent = new EchoMockAgent({ chunkDelayMs: 500 });
    const gateway = new Gateway({
      home: "/tmp/test-home",
      agent,
      services: [],
    });

    const activeService = makeQueryService("telegram");
    const queuedServiceOne = makeQueryService("telegram");
    const queuedServiceTwo = makeQueryService("telegram");
    const stopService = makeQueryService("telegram");

    const active = gateway.submitMessage(
      activeService,
      inbound("long running request", {
        type: "telegram",
        channelId: "1001",
      }),
    );
    await sleep(25);

    const queuedOne = gateway.submitMessage(
      queuedServiceOne,
      inbound("first queued ask", {
        type: "telegram",
        channelId: "1001",
      }),
    );
    const queuedTwo = gateway.submitMessage(
      queuedServiceTwo,
      inbound("second queued ask", {
        type: "telegram",
        channelId: "1001",
      }),
    );
    await sleep(25);

    await gateway.submitMessage(
      stopService,
      inbound("/stop", {
        type: "telegram",
        channelId: "1001",
      }),
    );

    await Promise.all([active, queuedOne, queuedTwo]);

    expect(agent.abortCount).toBeGreaterThanOrEqual(1);
    expect(agent.calls.length).toBe(2);
    expect(agent.calls[0]?.prompt).toBe("long running request");
    const stopPrompt = agent.calls[1]?.prompt ?? "";
    expect(stopPrompt).toContain("queued");
    expect(stopPrompt).toContain("first queued ask");
    expect(stopPrompt).toContain("second queued ask");
    expect(queuedServiceOne.messages).toEqual([
      {
        content:
          "Busy with another task right now. I queued your message and will reply when it finishes.",
        isPartial: false,
        options: { reason: "response" },
      },
    ]);
    expect(queuedServiceTwo.messages).toEqual([
      {
        content:
          "Busy with another task right now. I queued your message and will reply when it finishes.",
        isPartial: false,
        options: { reason: "response" },
      },
    ]);
  });

  test("propagates abort request to active query", async () => {
    const agent = new EchoMockAgent({ chunkDelayMs: 500 });
    const gateway = new Gateway({
      home: "/tmp/test-home",
      agent,
      services: [],
    });
    const service = makeQueryService();

    const pending = gateway.submitMessage(service, inbound("abort me"));
    await sleep(25);
    gateway.requestAbort();
    await pending;

    expect(agent.abortCount).toBeGreaterThanOrEqual(1);
    expect(service.messages).toEqual([]);
  });

  test("sends fallback error message on query failure", async () => {
    const agent = new EchoMockAgent({ failWith: "boom" });
    const gateway = new Gateway({
      home: "/tmp/test-home",
      agent,
      services: [],
    });
    const service = makeQueryService();

    await gateway.submitMessage(service, inbound("trigger"));

    expect(service.messages).toEqual([
      { content: "Error: boom", isPartial: false, options: { reason: "response" } },
    ]);
  });

  test("awaits onUserMessage handlers so scoped platform state remains valid while replying", async () => {
    const agent = new EchoMockAgent({ chunkDelayMs: 25 });
    const delivered: MessageRecord[] = [];
    let handler: UserMessageHandler = () => undefined;
    let activeReplyScope = false;

    const service: ChatService = {
      type: "telegram",
      capabilities: {
        supportsStreaming: true,
        supportsMarkdownTables: false,
      },
      onUserMessage: (nextHandler) => {
        handler = nextHandler;
      },
      start: async () => {
        activeReplyScope = true;
        try {
          await handler({
            content: "hello",
            context: {
              type: "telegram",
            },
          });
        } finally {
          activeReplyScope = false;
        }
      },
      stop: async () => undefined,
      sendMessage: async (content, isPartial) => {
        if (!activeReplyScope) {
          return;
        }
        delivered.push({ content, isPartial, options: { reason: "response" } });
      },
      sendStats: async () => undefined,
    };

    const gateway = new Gateway({
      home: "/tmp/test-home",
      agent,
      services: [service],
    });

    await gateway.start();
    await gateway.waitForAnyServiceStop();

    expect(delivered).toEqual([
      { content: "hello", isPartial: false, options: { reason: "response" } },
    ]);
  });

  test("updates last channel when inbound context contains channel id", async () => {
    const agent = new EchoMockAgent();
    const gateway = new Gateway({
      home: "/tmp/test-home",
      agent,
      services: [],
    });
    const service = makeQueryService("telegram");

    await gateway.submitMessage(
      service,
      inbound("hello", {
        type: "telegram",
        channelId: "1001",
      }),
    );

    expect(agent.getLastChannel()).toEqual({
      platform: "telegram",
      channelId: "1001",
    });
  });

  test("passes configured MCP servers to rpc queries", async () => {
    const agent = new EchoMockAgent();
    const mcpServers: Record<string, McpServerConfig> = {
      "xeno-cron": {
        type: "stdio",
        command: "echo",
        args: ["ok"],
      },
    };

    const gateway = new Gateway({
      home: "/tmp/test-home",
      agent,
      services: [],
      mcpServers,
    });
    const service = makeQueryService();

    await gateway.submitMessage(service, inbound("hello"));

    const configured = agent.calls[0]?.options?.mcpServers;
    expect(configured?.["xeno-cron"]).toEqual(mcpServers["xeno-cron"]);
    expect(configured?.["xeno-reply-attachment"]).toBeUndefined();
  });

  test("adds reply attachment MCP server to user queries", async () => {
    const agent = new EchoMockAgent();
    const gateway = new Gateway({
      home: "/tmp/test-home",
      agent,
      services: [],
    });
    const service = makeQueryService("telegram");

    await gateway.submitMessage(
      service,
      inbound("hello", {
        type: "telegram",
        channelId: "1001",
      }),
    );

    const configured = agent.calls[0]?.options?.mcpServers;
    expect(configured).toBeDefined();
    expect(configured?.["xeno-reply-attachment"]).toBeDefined();
  });

  test("adds rpc-specific MCP servers only for rpc user queries", async () => {
    const agent = new EchoMockAgent();
    const rpcOnlyMcpServers: Record<string, McpServerConfig> = {
      "xeno-messenger": {
        type: "stdio",
        command: "echo",
        args: ["rpc-notify"],
      },
    };

    const gateway = new Gateway({
      home: "/tmp/test-home",
      agent,
      services: [],
      rpcMcpServers: rpcOnlyMcpServers,
    });

    await gateway.submitMessage(makeQueryService("rpc"), inbound("hello from rpc"));
    await gateway.submitMessage(
      makeQueryService("telegram"),
      inbound("hello from telegram", {
        type: "telegram",
        channelId: "1001",
      }),
    );

    const rpcConfigured = agent.calls[0]?.options?.mcpServers;
    expect(rpcConfigured?.["xeno-messenger"]).toEqual(rpcOnlyMcpServers["xeno-messenger"]);
    expect(rpcConfigured?.["xeno-reply-attachment"]).toBeUndefined();

    const telegramConfigured = agent.calls[1]?.options?.mcpServers;
    expect(telegramConfigured?.["xeno-messenger"]).toBeUndefined();
    expect(telegramConfigured?.["xeno-reply-attachment"]).toBeDefined();
  });

  test("merges cron query MCP servers with gateway MCP servers", async () => {
    const agent = new EchoMockAgent();
    const baseMcpServers: Record<string, McpServerConfig> = {
      "xeno-cron": {
        type: "stdio",
        command: "echo",
        args: ["cron"],
      },
    };
    const cronOnlyMcpServers: Record<string, McpServerConfig> = {
      "xeno-messenger": {
        type: "stdio",
        command: "echo",
        args: ["notify"],
      },
    };

    const gateway = new Gateway({
      home: "/tmp/test-home",
      agent,
      services: [],
      mcpServers: baseMcpServers,
    });

    const result = await gateway.runCronQuery({
      taskId: "task-1",
      prompt: "hello from cron",
      isolatedContext: true,
      mcpServers: cronOnlyMcpServers,
    });

    expect(result.result).toBe("hello from cron");
    expect(agent.calls[0]?.options?.mcpServers).toEqual({
      ...baseMcpServers,
      ...cronOnlyMcpServers,
    });
    expect(agent.calls[0]?.options?.cronContext).toEqual({
      taskId: "task-1",
      model: undefined,
      isolatedContext: true,
    });
  });

  test("broadcasts messages to all services with target metadata", async () => {
    const agent = new EchoMockAgent();
    agent.updateLastChannel({
      type: "telegram",
      channelId: "1001",
    });

    const deliveries: Array<{
      service: PlatformType;
      content: string;
      isPartial: boolean;
      options?: OutboundMessageOptions;
    }> = [];

    const createService = (type: PlatformType): ChatService => ({
      type,
      capabilities: {
        supportsStreaming: true,
        supportsMarkdownTables: type === "rpc",
      },
      start: async () => undefined,
      stop: async () => undefined,
      onUserMessage: () => undefined,
      sendMessage: async (content, isPartial, options) => {
        deliveries.push({ service: type, content, isPartial, options });
      },
      sendStats: async () => undefined,
    });

    const gateway = new Gateway({
      home: "/tmp/test-home",
      agent,
      services: [createService("rpc"), createService("telegram")],
    });

    await gateway.broadcastMessage("attention");

    expect(deliveries).toEqual([
      {
        service: "rpc",
        content: "attention",
        isPartial: false,
        options: {
          reason: "proactive",
          target: {
            platform: "telegram",
            channelId: "1001",
          },
        },
      },
      {
        service: "telegram",
        content: "attention",
        isPartial: false,
        options: {
          reason: "proactive",
          target: {
            platform: "telegram",
            channelId: "1001",
          },
        },
      },
    ]);
  });

  test("uses provided target when send request includes target", async () => {
    const agent = new EchoMockAgent();
    agent.updateLastChannel({
      type: "telegram",
      channelId: "1001",
    });
    const deliveries: MessageRecord[] = [];
    const service: ChatService = {
      type: "telegram",
      capabilities: {
        supportsStreaming: true,
        supportsMarkdownTables: false,
      },
      start: async () => undefined,
      stop: async () => undefined,
      onUserMessage: () => undefined,
      sendMessage: async (content, isPartial, options) => {
        deliveries.push({ content, isPartial, options });
      },
      sendStats: async () => undefined,
    };

    const gateway = new Gateway({
      home: "/tmp/test-home",
      agent,
      services: [service],
    });

    const outcome = await gateway.sendMessage({
      content: "attention",
      target: {
        platform: "telegram",
        channelId: "2002",
      },
    });

    expect(outcome).toEqual({
      delivered: true,
      target: {
        platform: "telegram",
        channelId: "2002",
      },
    });
    expect(deliveries).toEqual([
      {
        content: "attention",
        isPartial: false,
        options: {
          reason: "proactive",
          target: {
            platform: "telegram",
            channelId: "2002",
          },
        },
      },
    ]);
  });

  test("reports not delivered for sends when no channel is available", async () => {
    const agent = new EchoMockAgent();
    const gateway = new Gateway({
      home: "/tmp/test-home",
      agent,
      services: [],
    });

    const outcome = await gateway.sendMessage({
      content: "attention",
    });

    expect(outcome).toEqual({
      delivered: false,
      reason: "No last channel is known yet.",
    });
  });
});
