import { describe, expect, test } from "bun:test";
import { setTimeout as sleep } from "node:timers/promises";
import type {
  ChatInboundMessage,
  ChatService,
  PlatformCapabilities,
  UserMessageHandler,
  PlatformType,
} from "../../src/chat/service";
import { Gateway } from "../../src/gateway";
import { EchoMockAgent } from "../helpers/echo-mock-agent";

type MessageRecord = {
  content: string;
  isPartial: boolean;
};

function makeQueryService(type: PlatformType = "console") {
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
    sendMessage: async (content: string, isPartial: boolean) => {
      messages.push({ content, isPartial });
    },
    sendStats: async (value: string) => {
      stats.push(value);
    },
  };
}

function inbound(content: string): ChatInboundMessage {
  return {
    content,
    context: {
      type: "console",
      metadata: {
        source: "test",
      },
    },
  };
}

describe("Gateway", () => {
  test("streams echo content and sends final response", async () => {
    const agent = new EchoMockAgent();
    const gateway = new Gateway({
      home: "/tmp/test-home",
      agent,
      services: [],
    });
    const service = makeQueryService();

    await gateway.submitMessage(service, inbound("hello"));

    expect(service.messages).toEqual([
      { content: "hello", isPartial: true },
      { content: "hello", isPartial: false },
    ]);
    expect(service.stats.length).toBe(1);
    expect(service.stats[0]).toContain("result=success");
    expect(agent.calls.length).toBe(1);
    expect(agent.calls[0]?.options?.platformContext?.type).toBe("console");
  });

  test("rejects a second request while one is active", async () => {
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
        content: "A request is already running. Press Ctrl-C to abort it.",
        isPartial: false,
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
    expect(service.messages).toEqual([{ content: "[No response]", isPartial: false }]);
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

    expect(service.messages).toEqual([{ content: "Error: boom", isPartial: false }]);
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
        delivered.push({ content, isPartial });
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
      { content: "hello", isPartial: true },
      { content: "hello", isPartial: false },
    ]);
  });
});
