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
import type { PlatformContext } from "./chat/service";
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

export interface AgentRuntime {
  getSessionId(): string | null;
  getConversationHistory(): Promise<ConversationTurn[]>;
  query(userPrompt: string, options?: QueryOptions): AsyncGenerator<SDKMessage>;
  abort(): void;
}

export class Agent implements AgentRuntime {
  readonly dir: string;
  readonly logger: pino.Logger;
  readonly pathToClaudeCodeExecutable: string | undefined;

  private abortController: AbortController | null = null;
  private sessionId: string | null;

  constructor(dir: string) {
    this.dir = dir;
    this.logger = logger.child({ home: dir });
    this.pathToClaudeCodeExecutable = process.env.PATH_TO_CLAUDE_CODE_EXECUTABLE;
    this.sessionId = this.loadSessionId();
  }

  getSessionId(): string | null {
    return this.sessionId;
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

  private loadSessionId(): string | null {
    try {
      if (!existsSync(this.sessionFilePath)) return null;

      const data = JSON.parse(readFileSync(this.sessionFilePath, "utf-8"));
      const sessionId = data.main_session_id as string;
      if (!sessionId) return null;
      this.logger.debug("Loaded session: %s", sessionId);
      return sessionId;
    } catch {
      return null;
    }
  }

  private persistSessionId(id: string) {
    let existingSession = null;
    try {
      if (existsSync(this.sessionFilePath)) {
        existingSession = JSON.parse(readFileSync(this.sessionFilePath, "utf-8"));
      }
    } catch {}

    try {
      mkdirSync(dirname(this.sessionFilePath), { recursive: true });
      const data = Object.assign({}, existingSession, { main_session_id: id });
      writeFileSync(this.sessionFilePath, JSON.stringify(data, null, 2));
      this.sessionId = id;
      this.logger.debug("Saved session: %s", id);
    } catch (e) {
      // ignore
      this.logger.error("Failed to save session: %s", e);
    }
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
