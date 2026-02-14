import { once } from "node:events";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";

import type { Agent } from "../../agent";
import { logger } from "../../logger";
import type { Attachment } from "../../media";
import type {
  AbortRequestHandler,
  ChatInboundMessage,
  ChatService,
  OutboundMessageOptions,
  OutboundMessageTarget,
  PlatformCapabilities,
  PlatformType,
  UserMessageHandler,
} from "../service";

const CONSOLE_CHANNEL_ID = "default";
const PROMPT = "> ";

export interface ConsolePlatformOptions {
  home: string;
  agent: Agent;
}

export class ConsolePlatform implements ChatService {
  readonly type: PlatformType = "rpc";
  readonly capabilities: PlatformCapabilities = {
    supportsStreaming: true,
    supportsMarkdownTables: true,
  };

  private readonly home: string;
  private readonly agent: Agent;
  private readonly platformLogger;

  private readline: ReadlineInterface | null = null;
  private readlineClosed = false;
  private activeQuery = false;
  private abortingQuery = false;
  private shuttingDown = false;
  private pendingAgentContent: string | null = null;

  private onUserMessageHandler: UserMessageHandler = () => undefined;
  private onAbortRequestHandler: AbortRequestHandler = () => undefined;

  private onSigInt: (() => void) | null = null;
  private onSigTerm: (() => void) | null = null;

  constructor(options: ConsolePlatformOptions) {
    this.home = options.home;
    this.agent = options.agent;
    this.platformLogger = logger.child({ service: "console", home: this.home });
  }

  onUserMessage(handler: UserMessageHandler): void {
    this.onUserMessageHandler = handler;
  }

  onAbortRequest(handler: AbortRequestHandler): void {
    this.onAbortRequestHandler = handler;
  }

  async start(): Promise<void> {
    this.platformLogger.info("Console platform starting");

    const readline = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    this.readline = readline;
    this.readlineClosed = false;

    this.onSigInt = () => this.handleInterrupt("SIGINT");
    this.onSigTerm = () => this.handleInterrupt("SIGTERM");
    process.on("SIGINT", this.onSigInt);
    process.on("SIGTERM", this.onSigTerm);

    try {
      readline.setPrompt(PROMPT);

      const sessionId = this.agent.getSessionId();
      if (sessionId) {
        this.addMessage("agent", `Resuming session: ${sessionId}`);
        const history = await this.agent.getConversationHistory();
        if (history.length > 0) {
          this.addMessage("agent", "[stats] Loaded conversation history.");
          for (const turn of history) {
            this.addMessage(turn.role === "assistant" ? "agent" : "user", turn.content);
          }
        }
      }

      readline.on("line", (line) => {
        const userInput = line.trim();
        if (!userInput || this.shuttingDown) {
          if (!this.shuttingDown) {
            this.prompt();
          }
          return;
        }

        if (this.activeQuery) {
          this.addMessage("agent", "A request is already running. Press Ctrl-C to abort it.");
          return;
        }

        this.addMessage("user", userInput);
        this.activeQuery = true;
        this.abortingQuery = false;
        this.pendingAgentContent = null;

        void this.forwardUserMessage(userInput);
      });

      readline.on("close", () => {
        this.readlineClosed = true;
        if (!this.shuttingDown) {
          this.shutdown("SIGTERM");
        }
      });

      this.prompt();
      await once(readline, "close");
    } finally {
      if (this.onSigInt) {
        process.off("SIGINT", this.onSigInt);
      }
      if (this.onSigTerm) {
        process.off("SIGTERM", this.onSigTerm);
      }

      if (this.readline && !this.readlineClosed) {
        this.readline.close();
      }

      this.readline = null;
      this.readlineClosed = false;
      this.pendingAgentContent = null;
      this.activeQuery = false;
      this.abortingQuery = false;
      this.shuttingDown = true;
    }

    this.platformLogger.info("Console platform stopped");
  }

  async stop(): Promise<void> {
    this.shutdown("SIGTERM");
  }

  async startTyping(): Promise<void> {
    return;
  }

  async stopTyping(): Promise<void> {
    return;
  }

  async sendMessage(
    content: string,
    isPartial: boolean,
    options?: OutboundMessageOptions,
  ): Promise<void> {
    if (!this.readline) {
      return;
    }

    if (
      options?.reason === "proactive" &&
      options.target &&
      options.target.platform !== this.type
    ) {
      if (!isPartial) {
        this.addMessage("agent", `Message sent to ${this.formatOutboundTarget(options.target)}.`);
      }
      return;
    }

    const suppressText = options?.suppressText === true;
    if (!suppressText) {
      this.pendingAgentContent = content;
    }

    if (isPartial) {
      return;
    }

    if (!suppressText) {
      this.addMessage("agent", this.pendingAgentContent || "[No response]");
    }
    this.printAttachments(options?.attachments);
    if (suppressText) {
      return;
    }
    this.pendingAgentContent = null;
    this.activeQuery = false;
    this.abortingQuery = false;
    this.prompt();
  }

  async sendStats(stats: string): Promise<void> {
    this.addMessage("agent", `[stats] ${stats}`);
  }

  private async forwardUserMessage(userInput: string): Promise<void> {
    try {
      const inbound: ChatInboundMessage = {
        content: userInput,
        context: {
          type: "rpc",
          channelId: CONSOLE_CHANNEL_ID,
          metadata: { home: this.home },
        },
      };
      await this.onUserMessageHandler(inbound);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.addMessage("agent", `Error: ${message}`);
      this.platformLogger.error({ error }, "Console user message handler failed");
      this.activeQuery = false;
      this.abortingQuery = false;
      this.pendingAgentContent = null;
      this.prompt();
    }
  }

  private handleInterrupt(source: "SIGINT" | "SIGTERM" | "keypress"): void {
    if (this.activeQuery) {
      if (!this.abortingQuery) {
        this.abortingQuery = true;
        this.addMessage("agent", "Aborting current request...");
        this.platformLogger.info({ source }, "Aborting active query");
        this.onAbortRequestHandler();
      } else {
        this.shutdown(source === "SIGTERM" ? "SIGTERM" : "SIGINT");
      }
      return;
    }

    this.shutdown(source === "SIGTERM" ? "SIGTERM" : "SIGINT");
  }

  private shutdown(signal: NodeJS.Signals): void {
    if (this.shuttingDown) {
      return;
    }

    this.shuttingDown = true;
    this.onAbortRequestHandler();
    this.platformLogger.info({ signal }, "Console shutdown");

    if (this.readline && !this.readlineClosed) {
      this.readline.close();
    }
  }

  private prompt(): void {
    if (!this.readline || this.readlineClosed || this.shuttingDown || this.activeQuery) {
      return;
    }

    this.readline.prompt();
  }

  private addMessage(role: "user" | "agent", content: string): void {
    if (!this.readline || this.readlineClosed) {
      return;
    }

    const label = role === "user" ? "user" : "agent";
    this.printLine(`[${label}] ${content}`);
  }

  private printLine(line: string): void {
    if (!this.readline || this.readlineClosed) {
      return;
    }

    const safeLine = line.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
    const promptPrefix = this.readline.getPrompt() || PROMPT;
    const typed = this.readline.line;

    process.stdout.write("\r");
    process.stdout.write(`${" ".repeat(promptPrefix.length + typed.length)}\r`);
    process.stdout.write(`${safeLine}\n`);

    if (!this.shuttingDown && !this.activeQuery) {
      this.prompt();
    }
  }

  private formatOutboundTarget(target: OutboundMessageTarget): string {
    return `${target.platform}:${target.channelId}`;
  }

  private printAttachments(attachments: Attachment[] | undefined): void {
    if (!attachments || attachments.length === 0) {
      return;
    }

    for (const attachment of attachments) {
      const label = attachment.fileName?.trim() || attachment.type;
      this.addMessage("agent", `[attachment: ${label}] ${attachment.path}`);
    }
  }
}
