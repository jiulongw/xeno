import { basename, resolve } from "node:path";
import { Codex } from "@openai/codex-sdk";
import type { ThreadEvent, ThreadItem, Thread } from "@openai/codex-sdk";
import pino from "pino";
import type { PlatformContext } from "../chat/service";
import { logger } from "../logger";
import { HEARTBEAT_TASK_ID, WEEKLY_NEW_SESSION_TASK_ID } from "../cron/types";
import type { Attachment } from "../media";
import type {
  AgentEvent,
  AgentOptions,
  AgentRuntime,
  ConversationTurn,
  CronContext,
  QueryOptions,
} from "./types";

interface AugmentPromptOptions {
  platformContext?: PlatformContext;
  cronContext?: CronContext;
  attachments?: Attachment[];
}

export class CodexAgent implements AgentRuntime {
  readonly dir: string;
  readonly logger: pino.Logger;

  private readonly codex: Codex;
  private readonly defaultModel: string | undefined;
  private readonly parentHome: string | undefined;
  private thread: Thread | null = null;
  private threadId: string | null = null;
  private abortController: AbortController | null = null;

  constructor(dir: string, options?: AgentOptions) {
    this.dir = dir;
    this.defaultModel = options?.defaultModel;
    this.parentHome = options?.parentHome ? resolve(options.parentHome) : undefined;
    this.logger = logger.child({ home: dir, provider: "codex" });

    const mcpBridgeConfig = options?.mcpBridge
      ? {
          mcp_servers: {
            xeno: {
              command: options.mcpBridge.command,
              args: [...options.mcpBridge.args, "--channel-key", options.channelKey ?? "__main__"],
            },
          },
        }
      : undefined;

    if (mcpBridgeConfig) {
      this.logger.info(
        { mcpBridge: mcpBridgeConfig.mcp_servers.xeno },
        "Codex MCP bridge configured",
      );
    }

    this.codex = new Codex({
      codexPathOverride: process.env.PATH_TO_CODEX_EXECUTABLE,
      config: mcpBridgeConfig,
    });
  }

  getSessionId(): string | null {
    return this.threadId;
  }

  async getConversationHistory(): Promise<ConversationTurn[]> {
    // Codex manages session history internally
    return [];
  }

  async *query(userPrompt: string, options?: QueryOptions): AsyncGenerator<AgentEvent> {
    this.abortController = new AbortController();
    const { platformContext, cronContext, attachments } = options || {};

    const model = cronContext?.model || this.defaultModel;

    const threadOptions = {
      workingDirectory: this.dir,
      sandboxMode: "danger-full-access" as const,
      approvalPolicy: "never" as const,
      ...(model ? { model } : {}),
    };

    // Start or resume thread
    if (this.threadId) {
      this.thread = this.codex.resumeThread(this.threadId, threadOptions);
      this.logger.info("Resuming Codex thread: %s", this.threadId);
    } else {
      this.thread = this.codex.startThread(threadOptions);
      this.logger.info("Starting new Codex thread");
    }

    const prompt = this.augmentPrompt(userPrompt, !this.threadId, {
      platformContext,
      cronContext,
      attachments,
    });

    const startedAt = Date.now();

    try {
      const streamedTurn = await this.thread.runStreamed(prompt, {
        signal: this.abortController.signal,
      });

      let lastAgentMessageText = "";
      let turns = 1;
      let costUsd = 0;

      for await (const event of streamedTurn.events) {
        if (event.type === "thread.started") {
          const threadStarted = event as { type: "thread.started"; thread_id: string };
          this.threadId = threadStarted.thread_id;
          this.logger.info("Codex thread started: %s", this.threadId);
          yield { type: "init", sessionId: this.threadId };
          continue;
        }

        if (event.type === "item.updated" || event.type === "item.started") {
          const itemEvent = event as { type: string; item: ThreadItem };
          if (itemEvent.item.type === "agent_message") {
            const text = (itemEvent.item as { type: "agent_message"; text: string }).text;
            if (text && text !== lastAgentMessageText) {
              const delta = text.slice(lastAgentMessageText.length);
              if (delta) {
                yield { type: "stream", text: delta };
              }
              lastAgentMessageText = text;
            }
          }
          continue;
        }

        if (event.type === "item.completed") {
          const itemEvent = event as { type: string; item: ThreadItem };
          if (itemEvent.item.type === "agent_message") {
            const text = (itemEvent.item as { type: "agent_message"; text: string }).text;
            if (text) {
              yield { type: "assistant", text };
              lastAgentMessageText = text;
            }
          }
          continue;
        }

        if (event.type === "turn.completed") {
          const turnCompleted = event as {
            type: "turn.completed";
            usage: {
              input_tokens: number;
              output_tokens: number;
              cached_input_tokens: number;
            } | null;
          };
          const durationMs = Date.now() - startedAt;
          yield {
            type: "result",
            subtype: "success",
            sessionId: this.threadId ?? "",
            turns,
            stopReason: "end_turn",
            durationMs,
            apiDurationMs: durationMs,
            costUsd,
          };
          continue;
        }

        if (event.type === "turn.failed") {
          const turnFailed = event as { type: "turn.failed"; error: { message: string } };
          const durationMs = Date.now() - startedAt;
          this.logger.error({ error: turnFailed.error.message }, "Codex turn failed");
          yield {
            type: "result",
            subtype: "error",
            sessionId: this.threadId ?? "",
            turns,
            stopReason: turnFailed.error.message,
            durationMs,
            apiDurationMs: durationMs,
            costUsd,
          };
          continue;
        }

        if (event.type === "error") {
          const errorEvent = event as { type: "error"; message: string };
          const durationMs = Date.now() - startedAt;
          this.logger.error({ error: errorEvent.message }, "Codex thread error");
          yield {
            type: "result",
            subtype: "error",
            sessionId: this.threadId ?? "",
            turns,
            stopReason: errorEvent.message,
            durationMs,
            apiDurationMs: durationMs,
            costUsd,
          };
          continue;
        }
      }
    } finally {
      this.abortController = null;
    }
  }

  abort(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.logger.info("Query aborted");
    }
  }

  private augmentPrompt(
    userPrompt: string,
    isNew: boolean,
    { platformContext, cronContext, attachments }: AugmentPromptOptions,
  ): string {
    const parts: string[] = [];
    let basePrompt = userPrompt;

    if (platformContext) {
      const name = platformContext.metadata?.firstName || platformContext.metadata?.username;
      if (name) {
        parts.push(`[message from ${name} on ${platformContext.type}]`);
      }
    }

    if (isNew) {
      parts.push("[This is a new session. It's time to wake up. Get oriented first.]");
    }

    if (cronContext) {
      const now = new Date();
      const cronArgs = [`now:${now.toISOString()}`, `local_now:${now.toString()}`];
      if (
        cronContext.taskId === HEARTBEAT_TASK_ID ||
        cronContext.taskId === WEEKLY_NEW_SESSION_TASK_ID ||
        !cronContext.isolatedContext
      ) {
        parts.push(`[You are triggered by cron task ${cronContext.taskId}.]`);
      } else {
        basePrompt = `/run-cron-task task_id:${cronContext.taskId} ${cronArgs.join(" ")} ${basePrompt}`;
      }
    }

    if (attachments && attachments.length > 0) {
      const lines = attachments.map((attachment, index) => {
        const fileName = attachment.fileName || basename(attachment.path);
        const caption = attachment.caption;
        const details = [
          `type=${attachment.type}`,
          `file_name=${fileName}`,
          `path=${attachment.path}`,
        ];
        if (caption) {
          details.push(`caption=${caption}`);
        }
        return `${index + 1}. ${details.join(", ")}`;
      });

      parts.push("[This message includes attachments. Read the files as needed.]", ...lines);
    }

    if (parts.length > 0) {
      parts.push(`[current local time is ${new Date().toString()}]`);
    }

    // Path restriction instructions for topic channels
    if (this.parentHome) {
      parts.push(
        `[IMPORTANT: You are in a topic channel. Do NOT access these paths in ${this.parentHome}: MEMORY.md, USER.md, HEARTBEAT.md, memory/, or sibling channel directories.]`,
      );
    }

    if (parts.length === 0) {
      return basePrompt;
    }

    return [...parts, "", basePrompt].join("\n");
  }
}
