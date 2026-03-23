import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  SDKMessage,
  SDKResultMessage,
  SDKSystemMessage,
  Options,
  McpServerConfig,
  HookCallbackMatcher,
} from "@anthropic-ai/claude-agent-sdk";
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

type SessionType = "new" | "resume" | "compact";

interface AugmentPromptOptions {
  platformContext?: PlatformContext;
  cronContext?: CronContext;
  attachments?: Attachment[];
}

class DeveloperSectionBuilder {
  private readonly lines: string[] = [];

  get empty(): boolean {
    return this.lines.length === 0;
  }

  push(line: string): this {
    if (line.length > 0) {
      this.lines.push(line);
    }
    return this;
  }

  pushAll(lines: string[]): this {
    for (const line of lines) {
      this.push(line);
    }
    return this;
  }

  build(): string {
    if (this.lines.length === 0) {
      return "";
    }
    return `<developer>${this.lines.join("\n")}</developer>`;
  }
}

export class ClaudeAgent implements AgentRuntime {
  readonly dir: string;
  readonly logger: pino.Logger;
  readonly pathToClaudeCodeExecutable: string | undefined;

  private readonly defaultModel: string | undefined;
  private readonly parentHome: string | undefined;
  private abortController: AbortController | null = null;
  private sessionId: string | null;

  constructor(dir: string, options?: AgentOptions) {
    this.dir = dir;
    this.defaultModel = options?.defaultModel;
    this.parentHome = options?.parentHome ? resolve(options.parentHome) : undefined;
    this.logger = logger.child({ home: dir });
    this.pathToClaudeCodeExecutable = process.env.PATH_TO_CLAUDE_CODE_EXECUTABLE;
    this.sessionId = this.loadSessionId();
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  clearMainSessionId(): void {
    const existingSession = this.readSessionData() ?? {};
    const existingSessionId = existingSession.main_session_id;

    if (existingSessionId === null && this.sessionId === null) {
      return;
    }

    try {
      this.writeSessionData({
        ...existingSession,
        main_session_id: null,
      });
      this.sessionId = null;
      this.logger.info("Cleared main_session_id from session state");
    } catch (error) {
      this.logger.error({ error }, "Failed to clear main_session_id");
    }
  }

  async getConversationHistory(): Promise<ConversationTurn[]> {
    if (!this.sessionId) {
      return [];
    }

    const sessionJsonlPath = this.getSessionJsonlPath(this.sessionId);
    if (!existsSync(sessionJsonlPath)) {
      this.logger.warn({ sessionJsonlPath }, "Session history file not found");
      return [];
    }

    let contents = "";
    try {
      contents = readFileSync(sessionJsonlPath, "utf-8");
    } catch (error) {
      this.logger.warn({ error, sessionJsonlPath }, "Failed to read session history file");
      return [];
    }

    const history: ConversationTurn[] = [];
    const lines = contents.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }

      const turn = this.parseHistoryTurn(parsed);
      if (!turn) {
        continue;
      }

      history.push(turn);
    }

    return history;
  }

  async *query(userPrompt: string, options?: QueryOptions): AsyncGenerator<AgentEvent> {
    this.abortController = new AbortController();
    const sessionId = this.sessionId;
    const { includePartialMessages, mcpServers, platformContext, cronContext, attachments } =
      options || {};

    let compactCalled = false;

    const preCompactHook: HookCallbackMatcher = {
      hooks: [
        async () => {
          compactCalled = true;
          return {};
        },
      ],
    };

    const preToolUseHooks: HookCallbackMatcher[] = [];
    const pathRestrictionHook = this.createPathRestrictionHook();
    if (pathRestrictionHook) {
      preToolUseHooks.push(pathRestrictionHook);
    }

    const queryOptions: Options = {
      abortController: this.abortController,
      cwd: this.dir,
      settingSources: ["project"],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      tools: { type: "preset", preset: "claude_code" },
      hooks: {
        PreCompact: [preCompactHook],
        ...(preToolUseHooks.length > 0 ? { PreToolUse: preToolUseHooks } : {}),
      },
      includePartialMessages,
      mcpServers: mcpServers as Record<string, McpServerConfig> | undefined,
    };

    if (this.pathToClaudeCodeExecutable) {
      queryOptions.pathToClaudeCodeExecutable = this.pathToClaudeCodeExecutable;
    }

    if (cronContext?.model) {
      queryOptions.model = cronContext.model;
    } else if (this.defaultModel) {
      queryOptions.model = this.defaultModel;
    }

    let sessionType: SessionType = "resume";

    if (sessionId) {
      queryOptions.resume = sessionId;
      this.logger.info("Resuming session: %s", sessionId);
    } else {
      this.logger.info("Starting new session");
      sessionType = "new";
    }

    const prompt = this.augmentPrompt(userPrompt, sessionType, {
      platformContext,
      cronContext,
      attachments,
    });

    const stream = query({ prompt, options: queryOptions });

    try {
      for await (const message of stream) {
        // Capture session ID from init message
        if (message.type === "system" && (message as SDKSystemMessage).subtype === "init") {
          const initMsg = message as SDKSystemMessage;
          this.persistSessionId(initMsg.session_id);
          this.logger.info("Session initialized: %s", initMsg.session_id);
          yield { type: "init", sessionId: initMsg.session_id };
          continue;
        }

        if (message.type === "result") {
          const result = message as SDKResultMessage;
          this.logResultStats(result, queryOptions.model);
          yield {
            type: "result",
            subtype: result.subtype as "success" | "error",
            sessionId: result.session_id,
            turns: result.num_turns,
            stopReason: result.stop_reason,
            durationMs: result.duration_ms,
            apiDurationMs: result.duration_api_ms,
            costUsd: result.total_cost_usd,
            modelUsage: result.modelUsage,
          };
          continue;
        }

        if (message.type === "assistant") {
          const text = this.extractAssistantText(message);
          if (text) {
            yield { type: "assistant", text };
          }
          continue;
        }

        if (message.type === "stream_event") {
          const text = this.extractStreamText(message);
          if (text) {
            yield { type: "stream", text };
          }
          continue;
        }
      }

      if (compactCalled) {
        this.logger.info("Session was compacted. Reloading memory...");
        const stream = query({
          prompt:
            "<developer>Session was compacted. You should bring your memory back.</developer>",
          options: queryOptions,
        });
        for await (const message of stream) {
          if (message.type === "result") {
            this.logResultStats(message as SDKResultMessage, queryOptions.model);
          }
        }
        this.logger.info("Memory reloaded");
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

  private extractAssistantText(message: SDKMessage): string {
    const maybeContent = (message.message as { content?: unknown }).content;
    if (!Array.isArray(maybeContent)) {
      return "";
    }

    let text = "";
    for (const block of maybeContent) {
      const record = block as Record<string, unknown> | null;
      if (!record || typeof record !== "object" || record.type !== "text") {
        continue;
      }
      const blockText = record.text;
      if (typeof blockText === "string") {
        text += blockText;
      }
    }
    return text;
  }

  private extractStreamText(message: SDKMessage): string {
    const event = (message as Record<string, unknown>).event as Record<string, unknown> | null;
    if (!event || typeof event !== "object") {
      return "";
    }

    if (event.type === "content_block_start") {
      const block = event.content_block as Record<string, unknown> | null;
      if (
        block &&
        typeof block === "object" &&
        block.type === "text" &&
        typeof block.text === "string"
      ) {
        return block.text;
      }
      return "";
    }

    if (event.type === "content_block_delta") {
      const delta = event.delta as Record<string, unknown> | null;
      if (
        delta &&
        typeof delta === "object" &&
        delta.type === "text_delta" &&
        typeof delta.text === "string"
      ) {
        return delta.text;
      }
      return "";
    }

    return "";
  }

  private createPathRestrictionHook(): HookCallbackMatcher | null {
    if (!this.parentHome) {
      return null;
    }

    const parentHome = this.parentHome;
    const ownDir = resolve(this.dir);
    const channelsDir = join(parentHome, "channels") + "/";

    const restrictedExact = [
      join(parentHome, "MEMORY.md"),
      join(parentHome, "USER.md"),
      join(parentHome, "HEARTBEAT.md"),
    ];
    const restrictedPrefix = join(parentHome, "memory") + "/";

    const isRestricted = (absPath: string): string | null => {
      for (const restricted of restrictedExact) {
        if (absPath === restricted) {
          return `Access to ${basename(absPath)} in parent home is restricted`;
        }
      }

      if (absPath.startsWith(restrictedPrefix) || absPath === restrictedPrefix.slice(0, -1)) {
        return "Access to parent home memory directory is restricted";
      }

      // Block sibling channels but allow own channel
      if (absPath.startsWith(channelsDir)) {
        if (absPath !== ownDir && !absPath.startsWith(ownDir + "/")) {
          return "Access to sibling channel directories is restricted";
        }
      }

      return null;
    };

    return {
      hooks: [
        async (params) => {
          if (!("tool_name" in params)) {
            return {};
          }

          const { tool_name, tool_input } = params as {
            tool_name: string;
            tool_input: unknown;
          };
          const input = tool_input as Record<string, unknown>;

          let rawPath: string | undefined;
          switch (tool_name) {
            case "Read":
            case "Edit":
            case "Write":
              rawPath = typeof input.file_path === "string" ? input.file_path : undefined;
              break;
            case "Glob":
            case "Grep":
              rawPath = typeof input.path === "string" ? input.path : undefined;
              break;
            default:
              return {};
          }

          if (!rawPath) {
            return {};
          }

          const absPath = resolve(ownDir, rawPath);
          const reason = isRestricted(absPath);
          if (reason) {
            this.logger.warn({ tool: tool_name, path: rawPath }, reason);
            return { decision: "block" as const, reason };
          }

          return {};
        },
      ],
    };
  }

  private augmentPrompt(
    userPrompt: string,
    sessionType: SessionType,
    { platformContext, cronContext, attachments }: AugmentPromptOptions,
  ): string {
    const devHeader = new DeveloperSectionBuilder();
    const devFooter = new DeveloperSectionBuilder();
    let basePrompt = userPrompt;

    if (platformContext) {
      const name = platformContext.metadata?.firstName || platformContext.metadata?.username;
      if (name) {
        devHeader.push(`message from ${name} on ${platformContext.type}`);
      }
    }

    if (sessionType === "new") {
      devHeader.push("This is a new session. It's time to wake up. Get oriented first.");
    }

    if (cronContext) {
      const timeContext = this.getLocalTimeContext();
      const cronArgs = [`now:${timeContext.nowUtcIso}`, `local_now:${timeContext.nowLocalIso}`];
      if (
        cronContext.taskId === HEARTBEAT_TASK_ID ||
        cronContext.taskId === WEEKLY_NEW_SESSION_TASK_ID ||
        !cronContext.isolatedContext
      ) {
        devHeader.push(`You are triggered by cron task ${cronContext.taskId}.`);
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

      devFooter.push(
        "This message includes attachments. Use the Read tool to inspect files as needed.",
      );
      devFooter.pushAll(lines);
    }

    if (!devHeader.empty) {
      devHeader.push(`current local time is ${new Date().toString()}`);
    }

    return [devHeader.build(), basePrompt, devFooter.build()]
      .filter((part) => part.length > 0)
      .join("\n\n");
  }

  private getLocalTimeContext(date: Date = new Date()): {
    nowUtcIso: string;
    nowLocalIso: string;
  } {
    return {
      nowUtcIso: date.toISOString(),
      nowLocalIso: this.toLocalIsoWithOffset(date),
    };
  }

  private toLocalIsoWithOffset(date: Date): string {
    const pad = (value: number): string => String(value).padStart(2, "0");
    const year = date.getFullYear();
    const month = pad(date.getMonth() + 1);
    const day = pad(date.getDate());
    const hours = pad(date.getHours());
    const minutes = pad(date.getMinutes());
    const seconds = pad(date.getSeconds());

    const offsetMinutes = -date.getTimezoneOffset();
    const sign = offsetMinutes >= 0 ? "+" : "-";
    const absOffsetMinutes = Math.abs(offsetMinutes);
    const offsetHours = pad(Math.floor(absOffsetMinutes / 60));
    const offsetMins = pad(absOffsetMinutes % 60);

    return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}${sign}${offsetHours}:${offsetMins}`;
  }

  private get sessionFilePath(): string {
    return join(this.dir, ".xeno", "session.json");
  }

  private loadSessionId(): string | null {
    const data = this.readSessionData();
    if (!data) {
      return null;
    }

    const sessionId =
      typeof data.main_session_id === "string" && data.main_session_id.length > 0
        ? data.main_session_id
        : null;
    if (sessionId) {
      this.logger.debug("Loaded session: %s", sessionId);
    }

    return sessionId;
  }

  private persistSessionId(id: string) {
    const existingSession = this.readSessionData() ?? {};
    const existingSessionId =
      typeof existingSession.main_session_id === "string" ? existingSession.main_session_id : null;

    if (existingSessionId === id) {
      this.sessionId = id;
      return;
    }

    try {
      this.writeSessionData({
        ...existingSession,
        main_session_id: id,
      });
      this.sessionId = id;
      this.logger.debug("Saved session: %s", id);
    } catch (error) {
      this.logger.error({ error }, "Failed to save session");
    }
  }

  private readSessionData(): Record<string, unknown> | null {
    try {
      if (!existsSync(this.sessionFilePath)) {
        return null;
      }

      const parsed: unknown = JSON.parse(readFileSync(this.sessionFilePath, "utf-8"));
      if (!parsed || typeof parsed !== "object") {
        return null;
      }

      return parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  private writeSessionData(data: Record<string, unknown>): void {
    mkdirSync(dirname(this.sessionFilePath), { recursive: true });
    writeFileSync(this.sessionFilePath, JSON.stringify(data, null, 2));
  }

  private getSessionJsonlPath(sessionId: string): string {
    const projectDir = this.getClaudeProjectDirForPath(this.dir);
    return join(homedir(), ".claude", "projects", projectDir, `${sessionId}.jsonl`);
  }

  private getClaudeProjectDirForPath(path: string): string {
    const resolved = resolve(path);
    return resolved.replaceAll("/", "-");
  }

  private parseHistoryTurn(entry: unknown): ConversationTurn | null {
    if (!entry || typeof entry !== "object") {
      return null;
    }

    const record = entry as Record<string, unknown>;
    if (record.type === "user") {
      const message = this.getRecord(record.message);
      if (message?.role !== "user") {
        return null;
      }
      const text = this.extractTextContent(message.content);
      if (!text || text.startsWith("[Request interrupted")) {
        return null;
      }
      return { role: "user", content: text };
    }

    if (record.type === "assistant") {
      const message = this.getRecord(record.message);
      if (message?.role !== "assistant") {
        return null;
      }
      const text = this.extractTextContent(message.content);
      if (!text) {
        return null;
      }
      return { role: "assistant", content: text };
    }

    return null;
  }

  private getRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  }

  private extractTextContent(content: unknown): string {
    if (typeof content === "string") {
      return content;
    }
    if (!Array.isArray(content)) {
      return "";
    }

    let text = "";
    for (const block of content) {
      if (!block || typeof block !== "object") {
        continue;
      }
      const record = block as Record<string, unknown>;
      if (record.type === "text" && typeof record.text === "string") {
        text += record.text;
      }
    }
    return text.trim();
  }

  private logResultStats(result: SDKResultMessage, requestedModel: string | undefined): void {
    this.logger.info(
      {
        stats: {
          sessionId: result.session_id,
          turns: result.num_turns,
          stopReason: result.stop_reason,
          durationMs: result.duration_ms,
          apiDurationMs: result.duration_api_ms,
          costUsd: result.total_cost_usd,
          requestedModel: requestedModel ?? null,
          modelUsage: result.modelUsage,
        },
      },
      "Agent query stats",
    );
  }
}
