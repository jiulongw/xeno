import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  SDKMessage,
  SDKSystemMessage,
  HookInput,
  HookCallbackMatcher,
  Options,
  McpServerConfig,
} from "@anthropic-ai/claude-agent-sdk";
import pino from "pino";
import type { PlatformContext, PlatformType } from "./chat/service";
import { extractText } from "./chat/stream";
import { logger } from "./logger";

export interface QueryOptions {
  includePartialMessages?: boolean;
  mcpServers?: Record<string, McpServerConfig>;
  platformContext?: PlatformContext;
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

export interface IsolatedQueryOptions {
  home: string;
  prompt: string;
  model?: string;
  maxTurns?: number;
  systemPromptAppend?: string;
  pathToClaudeCodeExecutable?: string;
  abortController?: AbortController;
}

export async function runIsolatedQuery(options: IsolatedQueryOptions): Promise<{
  result: string;
  durationMs: number;
}> {
  const startedAt = Date.now();
  const abortController = options.abortController ?? new AbortController();
  const queryOptions: Options = {
    abortController,
    cwd: options.home,
    settingSources: ["project"],
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    tools: { type: "preset", preset: "claude_code" },
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: options.systemPromptAppend,
    },
    includePartialMessages: true,
    persistSession: false,
    model: options.model,
    maxTurns: options.maxTurns,
  };

  const executablePath =
    options.pathToClaudeCodeExecutable ?? process.env.PATH_TO_CLAUDE_CODE_EXECUTABLE;
  if (executablePath) {
    queryOptions.pathToClaudeCodeExecutable = executablePath;
  }

  const stream = query({ prompt: options.prompt, options: queryOptions });
  let streamed = "";
  let assistantFinal = "";
  let resultFallback = "";

  for await (const message of stream) {
    if (message.type === "stream_event") {
      streamed += extractText(message);
      continue;
    }

    if (message.type === "assistant") {
      assistantFinal = extractText(message);
      continue;
    }

    if (message.type === "result") {
      const record = message as Record<string, unknown>;
      const maybeResult = record.result;
      if (typeof maybeResult === "string") {
        resultFallback = maybeResult;
      }
    }
  }

  return {
    result: streamed || assistantFinal || resultFallback,
    durationMs: Date.now() - startedAt,
  };
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

  updateLastChannel(context: PlatformContext): void {
    const channelId = context.channelId?.trim();
    if (!channelId) {
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
    const { includePartialMessages, mcpServers, platformContext } = options || {};

    const preCompactHook: HookCallbackMatcher = {
      hooks: [
        async (input: HookInput) => {
          return this.preCompactHook(input, platformContext);
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

    if (sessionId) {
      queryOptions.resume = sessionId;
      this.logger.info("Resuming session: %s", sessionId);
    } else {
      this.logger.info("Starting new session");
    }

    const stream = query({ prompt: userPrompt, options: queryOptions });

    try {
      for await (const message of stream) {
        // Capture session ID from init message
        if (message.type === "system" && (message as SDKSystemMessage).subtype === "init") {
          const initMsg = message as SDKSystemMessage;
          this.persistSessionId(initMsg.session_id);
          this.logger.info("Session initialized: %s", initMsg.session_id);
        }

        yield message;
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

  private async preCompactHook(_input: HookInput, platformContext?: PlatformContext) {
    this.logger.info({ platformContext }, "PreCompact hook triggered");

    const platformNote = this.getPlatformSystemMessage(platformContext);
    return {
      systemMessage: [
        "The session is about to be compacted (summarized). Now it is a good time to reflect and update your long-term memory.",
        platformNote,
      ]
        .filter((part) => part.length > 0)
        .join("\n\n"),
    };
  }

  private getPlatformSystemMessage(platformContext?: PlatformContext): string {
    if (!platformContext) {
      return "";
    }

    const serializedContext = JSON.stringify(platformContext);
    const formattingHint = this.getPlatformFormattingHint(platformContext.type);

    return [`Platform context: ${serializedContext}.`, formattingHint]
      .filter((part) => part.length > 0)
      .join("\n");
  }

  private getPlatformFormattingHint(type: PlatformContext["type"]): string {
    if (type === "telegram" || type === "discord" || type === "slack") {
      return "Formatting hint: Avoid markdown tables. Prefer concise bullet lists.";
    }

    return "";
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
}
