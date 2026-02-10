import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import type { PlatformType } from "../chat/service";
import type { SendMessageRequest, SendMessageResult } from "../gateway";

type MessengerMcpServerOptions = {
  sendMessage: (request: SendMessageRequest) => Promise<SendMessageResult>;
};

const PLATFORM_VALUES: [PlatformType, ...PlatformType[]] = [
  "console",
  "telegram",
  "discord",
  "slack",
];

export function createMessengerMcpServer(options: MessengerMcpServerOptions) {
  return createSdkMcpServer({
    name: "xeno-messenger",
    version: "1.0.0",
    tools: [
      tool(
        "send_message",
        "Send a message to the user. If target is omitted, the last known channel is used.",
        {
          content: z.string().min(1),
          target: z
            .object({
              platform: z.enum(PLATFORM_VALUES),
              channel_id: z.string().min(1),
            })
            .optional(),
        },
        async (args) => {
          const outcome = await options.sendMessage({
            content: args.content,
            target: args.target
              ? {
                  platform: args.target.platform,
                  channelId: args.target.channel_id,
                }
              : undefined,
          });

          if (!outcome.delivered) {
            return toolResult(`Message was not sent: ${outcome.reason ?? "unknown reason"}.`, {
              delivered: false,
              reason: outcome.reason ?? null,
            });
          }

          return toolResult(
            `Message sent to ${outcome.target?.platform}:${outcome.target?.channelId}.`,
            {
              delivered: true,
              target: outcome.target
                ? {
                    platform: outcome.target.platform,
                    channel_id: outcome.target.channelId,
                  }
                : null,
            },
          );
        },
      ),
    ],
  });
}

function toolResult(text: string, structuredContent?: Record<string, unknown>) {
  return {
    content: [
      {
        type: "text" as const,
        text,
      },
    ],
    structuredContent,
  };
}
