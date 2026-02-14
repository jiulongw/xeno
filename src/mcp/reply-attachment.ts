import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import type { Attachment, AttachmentType } from "../media";

type SendAttachmentResult = {
  delivered: boolean;
  reason?: string;
};

type ReplyAttachmentMcpServerOptions = {
  sendAttachment: (attachment: Attachment) => Promise<SendAttachmentResult>;
};

const ATTACHMENT_TYPE_VALUES: [AttachmentType, ...AttachmentType[]] = [
  "image",
  "video",
  "audio",
  "voice",
  "document",
  "animation",
  "sticker",
];

export function createReplyAttachmentMcpServer(options: ReplyAttachmentMcpServerOptions) {
  return createSdkMcpServer({
    name: "xeno-reply-attachment",
    version: "1.0.0",
    tools: [
      tool(
        "send_attachment",
        "Send one attachment to the active reply channel without sending text content.",
        {
          type: z.enum(ATTACHMENT_TYPE_VALUES),
          path: z.string().min(1),
          mime_type: z.string().min(1).optional(),
          file_name: z.string().min(1).optional(),
          caption: z.string().min(1).optional(),
        },
        async (args) => {
          const outcome = await options.sendAttachment({
            type: args.type,
            path: args.path,
            mimeType: args.mime_type,
            fileName: args.file_name,
            caption: args.caption,
          });

          if (!outcome.delivered) {
            return toolResult(`Attachment was not sent: ${outcome.reason ?? "unknown reason"}.`, {
              delivered: false,
              reason: outcome.reason ?? null,
            });
          }

          return toolResult("Attachment sent.", {
            delivered: true,
          });
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
