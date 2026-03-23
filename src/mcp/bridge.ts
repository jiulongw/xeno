import { createConnection, type Socket } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v4";
import { JsonRpcPeer } from "../ipc/json-rpc";
import { getGatewaySocketPath } from "../ipc/socket";
import type { MAIN_CHANNEL_KEY } from "../channel/types";

type BridgeOptions = {
  home: string;
  channelKey: string;
};

function parseBridgeArgs(argv: string[]): BridgeOptions {
  let home: string | undefined;
  let channelKey: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--home") {
      home = argv[++i];
    } else if (argv[i] === "--channel-key") {
      channelKey = argv[++i];
    }
  }

  if (!home) {
    throw new Error("--home is required for mcp-bridge");
  }

  return { home, channelKey: channelKey ?? "__main__" };
}

async function connectToGateway(
  socketPath: string,
): Promise<{ socket: Socket; peer: JsonRpcPeer }> {
  const socket = await new Promise<Socket>((resolve, reject) => {
    const s = createConnection(socketPath);
    s.once("connect", () => resolve(s));
    s.once("error", reject);
  });
  const peer = new JsonRpcPeer(socket, "mcp-bridge");
  return { socket, peer };
}

export async function runMcpBridge(argv: string[]): Promise<void> {
  const options = parseBridgeArgs(argv);
  const socketPath = getGatewaySocketPath(options.home);
  const { socket, peer } = await connectToGateway(socketPath);

  const server = new McpServer({
    name: "xeno",
    version: "1.0.0",
  });

  // --- Cron tools ---

  server.tool(
    "create_cron_task",
    "Create a recurring cron task with interval_minutes or cron_expression, or a one-shot task with run_at.",
    {
      name: z.string().min(1),
      prompt: z.string().min(1),
      interval_minutes: z.number().positive().optional(),
      run_at: z.string().min(1).optional(),
      cron_expression: z.string().min(1).optional(),
      notify: z.enum(["auto", "never"]).optional(),
      isolated_context: z.boolean().optional(),
      max_turns: z.number().int().positive().optional(),
      enabled: z.boolean().optional(),
    },
    async (args) => {
      const result = await peer.request("gateway.mcp.cron.create", {
        channelKey: options.channelKey,
        ...args,
      });
      return result as { content: { type: "text"; text: string }[] };
    },
  );

  server.tool(
    "list_cron_tasks",
    "List all cron tasks including schedule, status, and last run details.",
    {},
    async () => {
      const result = await peer.request("gateway.mcp.cron.list", {
        channelKey: options.channelKey,
      });
      return result as { content: { type: "text"; text: string }[] };
    },
  );

  server.tool(
    "update_cron_task",
    "Update cron task fields like schedule, prompt, and enabled status.",
    {
      id: z.string().min(1),
      name: z.string().min(1).optional(),
      prompt: z.string().min(1).optional(),
      interval_minutes: z.number().positive().optional(),
      run_at: z.string().min(1).optional(),
      cron_expression: z.string().min(1).optional(),
      notify: z.enum(["auto", "never"]).optional(),
      isolated_context: z.boolean().optional(),
      max_turns: z.union([z.number().int().positive(), z.null()]).optional(),
      enabled: z.boolean().optional(),
    },
    async (args) => {
      const result = await peer.request("gateway.mcp.cron.update", {
        channelKey: options.channelKey,
        ...args,
      });
      return result as { content: { type: "text"; text: string }[] };
    },
  );

  server.tool(
    "delete_cron_task",
    "Delete a cron task by ID.",
    {
      id: z.string().min(1),
    },
    async (args) => {
      const result = await peer.request("gateway.mcp.cron.delete", {
        channelKey: options.channelKey,
        ...args,
      });
      return result as { content: { type: "text"; text: string }[] };
    },
  );

  // --- Messenger tools ---

  server.tool(
    "send_message",
    "Send a message to the user with optional attachments. If target is omitted, the last known channel is used.",
    {
      content: z.string().min(1),
      target: z
        .object({
          platform: z.enum(["telegram", "discord", "slack"]),
          channel_id: z.string().min(1),
        })
        .optional(),
      attachments: z
        .array(
          z.object({
            type: z.enum(["image", "video", "audio", "voice", "document", "animation", "sticker"]),
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
      const result = await peer.request("gateway.mcp.send_message", args);
      return result as { content: { type: "text"; text: string }[] };
    },
  );

  // Connect stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Clean up on gateway socket close
  peer.setCloseHandler(() => {
    process.exit(1);
  });

  // Clean up on process exit
  process.on("SIGINT", () => {
    socket.end();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    socket.end();
    process.exit(0);
  });
}
