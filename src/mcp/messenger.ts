import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import type { PlatformType } from "../chat/service";
import type { SendMessageRequest, SendMessageResult } from "../gateway";
import type { AttachmentType } from "../media";

type MessengerMcpServerOptions = {
  sendMessage: (request: SendMessageRequest) => Promise<SendMessageResult>;
};

const PLATFORM_VALUES: [PlatformType, ...PlatformType[]] = [
  "console",
  "telegram",
  "discord",
  "slack",
];
const ATTACHMENT_TYPE_VALUES: [AttachmentType, ...AttachmentType[]] = [
  "image",
  "video",
  "audio",
  "document",
  "animation",
  "sticker",
];

export function createMessengerMcpServer(options: MessengerMcpServerOptions) {
  return createSdkMcpServer({
    name: "xeno-messenger",
    version: "1.0.0",
    tools: [
      tool(
        "send_message",
        "Send a message to the user with optional attachments. If target is omitted, the last known channel is used.",
        {
          content: z.string().min(1),
          target: z
            .object({
              platform: z.enum(PLATFORM_VALUES),
              channel_id: z.string().min(1),
            })
            .optional(),
          attachments: z
            .array(
              z.object({
                type: z.enum(ATTACHMENT_TYPE_VALUES),
                path: z.string().min(1),
                mime_type: z.string().min(1).optional(),
                file_name: z.string().min(1).optional(),
                caption: z.string().min(1).optional(),
              }),
            )
            .max(10)
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
            attachments: args.attachments?.map((attachment) => ({
              type: attachment.type,
              path: attachment.path,
              mimeType: attachment.mime_type,
              fileName: attachment.file_name,
              caption: attachment.caption,
            })),
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
