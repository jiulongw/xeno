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
import type { PlatformContext, PlatformType } from "./chat/service";
import { logger } from "./logger";
import { HEARTBEAT_TASK_ID, WEEKLY_NEW_SESSION_TASK_ID } from "./cron/types";
import type { Attachment } from "./media";

export interface QueryOptions {
  includePartialMessages?: boolean;
  mcpServers?: Record<string, McpServerConfig>;
  platformContext?: PlatformContext;
  cronContext?: CronContext;
  attachments?: Attachment[];
}

export interface CronContext {
  taskId: string;
  model?: string;
}

export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
}

export interface LastChannel {
  platform: PlatformType;
  channelId: string;
}

export interface AgentRuntime {
  getSessionId(): string | null;
  getLastChannel(): LastChannel | null;
  updateLastChannel(context: PlatformContext): void;
  getConversationHistory(): Promise<ConversationTurn[]>;
  query(userPrompt: string, options?: QueryOptions): AsyncGenerator<SDKMessage>;
  abort(): void;
}

type SessionType = "new" | "resume" | "compact";

interface AugmentPromptOptions {
  platformContext?: PlatformContext;
  cronContext?: CronContext;
  attachments?: Attachment[];
}

class DeveloperSectionBuilder {
  private readonly lines: string[] = [];

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

export class Agent implements AgentRuntime {
  readonly dir: string;
  readonly logger: pino.Logger;
  readonly pathToClaudeCodeExecutable: string | undefined;

  private abortController: AbortController | null = null;
  private sessionId: string | null;
  private lastChannel: LastChannel | null;

  constructor(dir: string) {
    this.dir = dir;
    this.logger = logger.child({ home: dir });
    this.pathToClaudeCodeExecutable = process.env.PATH_TO_CLAUDE_CODE_EXECUTABLE;
    const state = this.loadSessionState();
    this.sessionId = state.sessionId;
    this.lastChannel = state.lastChannel;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  getLastChannel(): LastChannel | null {
    if (!this.lastChannel) {
      return null;
    }
    return { ...this.lastChannel };
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

  updateLastChannel(context: PlatformContext): void {
    const channelId = context.channelId?.trim();
    if (context.type === "console" || !channelId) {
      // proactive message not supported in console.
      return;
    }

    const next: LastChannel = {
      platform: context.type,
      channelId,
    };

    if (this.isSameLastChannel(this.lastChannel, next)) {
      return;
    }

    const existingSession = this.readSessionData() ?? {};
    const existingLastChannel = this.parseLastChannel(existingSession.last_channel);
    if (this.isSameLastChannel(existingLastChannel, next)) {
      this.lastChannel = existingLastChannel;
      return;
    }

    try {
      this.writeSessionData({
        ...existingSession,
        last_channel: {
          platform: next.platform,
          channel_id: next.channelId,
        },
      });
      this.lastChannel = next;
      this.logger.debug({ lastChannel: next }, "Saved last channel");
    } catch (error) {
      this.logger.error({ error }, "Failed to save last channel");
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

  async *query(userPrompt: string, options?: QueryOptions): AsyncGenerator<SDKMessage> {
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

    const queryOptions: Options = {
      abortController: this.abortController,
      cwd: this.dir,
      settingSources: ["project"],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      tools: { type: "preset", preset: "claude_code" },
      hooks: {
        PreCompact: [preCompactHook],
      },
      includePartialMessages,
      mcpServers,
    };

    if (this.pathToClaudeCodeExecutable) {
      queryOptions.pathToClaudeCodeExecutable = this.pathToClaudeCodeExecutable;
    }

    if (cronContext && cronContext.model) {
      queryOptions.model = cronContext.model;
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
        }

        if (message.type === "result") {
          this.logResultStats(message, queryOptions.model);
        }

        yield message;
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
            this.logResultStats(message, queryOptions.model);
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
      devHeader.push("This is a new session, wake up, get oriented first.");
    }

    if (cronContext) {
      const timeContext = this.getLocalTimeContext();
      const cronArgs = [`now:${timeContext.nowUtcIso}`, `local_now:${timeContext.nowLocalIso}`];
      if (cronContext.taskId === HEARTBEAT_TASK_ID) {
        basePrompt = `/heartbeat ${cronArgs.join(" ")} ${basePrompt}`;
      } else if (cronContext.taskId === WEEKLY_NEW_SESSION_TASK_ID) {
        // Do nothing, we don't need to augment the prompt for this task.
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

  private loadSessionState(): { sessionId: string | null; lastChannel: LastChannel | null } {
    const data = this.readSessionData();
    if (!data) {
      return { sessionId: null, lastChannel: null };
    }

    const sessionId =
      typeof data.main_session_id === "string" && data.main_session_id.length > 0
        ? data.main_session_id
        : null;
    const lastChannel = this.parseLastChannel(data.last_channel);
    if (sessionId) {
      this.logger.debug("Loaded session: %s", sessionId);
    }
    if (lastChannel) {
      this.logger.debug({ lastChannel }, "Loaded last channel");
    }

    return { sessionId, lastChannel };
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

  private parseLastChannel(value: unknown): LastChannel | null {
    const record = this.getRecord(value);
    if (!record) {
      return null;
    }

    const platform = record.platform;
    const channelId = typeof record.channel_id === "string" ? record.channel_id.trim() : "";
    if (!this.isPlatformType(platform) || channelId.length === 0) {
      return null;
    }

    return {
      platform,
      channelId,
    };
  }

  private isPlatformType(value: unknown): value is PlatformType {
    return value === "console" || value === "telegram" || value === "discord" || value === "slack";
  }

  private isSameLastChannel(left: LastChannel | null, right: LastChannel): boolean {
    return left?.platform === right.platform && left?.channelId === right.channelId;
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
