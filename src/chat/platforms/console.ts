import { once } from "node:events";
import {
  BoxRenderable,
  CliRenderEvents,
  InputRenderable,
  InputRenderableEvents,
  ScrollBoxRenderable,
  TextAttributes,
  TextRenderable,
  createCliRenderer,
  type CliRenderer,
  type KeyEvent,
} from "@opentui/core";

import type { Agent } from "../../agent";
import { logger } from "../../logger";
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

export interface ConsolePlatformOptions {
  home: string;
  agent: Agent;
}

export class ConsolePlatform implements ChatService {
  readonly type: PlatformType = "console";
  readonly capabilities: PlatformCapabilities = {
    supportsStreaming: true,
    supportsMarkdownTables: true,
  };

  private readonly home: string;
  private readonly agent: Agent;
  private readonly platformLogger;

  private renderer: CliRenderer | null = null;
  private conversationList: ScrollBoxRenderable | null = null;
  private input: InputRenderable | null = null;
  private pendingAgentMessage: TextRenderable | null = null;

  private activeQuery = false;
  private abortingQuery = false;
  private shuttingDown = false;

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
    const renderer = await createCliRenderer({
      exitOnCtrlC: false,
    });
    this.renderer = renderer;

    const app = new BoxRenderable(renderer, {
      id: "app",
      width: "100%",
      height: "100%",
      flexDirection: "column",
      padding: 1,
      gap: 1,
      backgroundColor: "#1f2335",
    });

    const conversationList = new ScrollBoxRenderable(renderer, {
      id: "conversation-list",
      width: "100%",
      flexGrow: 1,
      scrollY: true,
      stickyScroll: true,
      stickyStart: "bottom",
      border: true,
      borderStyle: "rounded",
      borderColor: "#565f89",
      padding: 1,
      backgroundColor: "#24283b",
    });
    this.conversationList = conversationList;

    const inputBar = new BoxRenderable(renderer, {
      id: "input-bar",
      width: "100%",
      minHeight: 3,
      maxHeight: 3,
      border: true,
      borderStyle: "rounded",
      borderColor: "#565f89",
      paddingLeft: 1,
      paddingRight: 1,
      justifyContent: "center",
      backgroundColor: "#1a1b26",
    });

    const input = new InputRenderable(renderer, {
      id: "chat-input",
      width: "100%",
      placeholder: "Type a message and press Enter",
      backgroundColor: "#1a1b26",
      focusedBackgroundColor: "#1a1b26",
      textColor: "#c0caf5",
      cursorColor: "#7aa2f7",
      placeholderColor: "#7f849c",
    });
    this.input = input;

    this.onSigInt = () => this.handleInterrupt("SIGINT");
    this.onSigTerm = () => this.handleInterrupt("SIGTERM");
    process.on("SIGINT", this.onSigInt);
    process.on("SIGTERM", this.onSigTerm);

    try {
      input.on(InputRenderableEvents.ENTER, async () => {
        const userInput = input.value.trim();
        if (!userInput) {
          return;
        }
        if (this.activeQuery) {
          this.addMessage("agent", "A request is already running. Press Ctrl-C to abort it.");
          return;
        }

        this.addMessage("user", userInput);
        input.value = "";
        this.pendingAgentMessage = this.addMessage("agent", "");
        this.activeQuery = true;
        this.abortingQuery = false;

        try {
          const inbound: ChatInboundMessage = {
            content: userInput,
            context: {
              type: "console",
              metadata: { home: this.home },
            },
          };
          await this.onUserMessageHandler(inbound);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.addMessage("agent", `Error: ${message}`);
          this.finishAgentMessage("[No response]");
          this.platformLogger.error({ error }, "Console user message handler failed");
        }
      });

      renderer.keyInput.on("keypress", (key: KeyEvent) => {
        if (key.ctrl && key.name === "c") {
          this.handleInterrupt("keypress");
        }
      });

      app.add(conversationList);
      inputBar.add(input);
      app.add(inputBar);
      renderer.root.add(app);
      input.focus();
      renderer.start();

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

      if (!renderer.isDestroyed) {
        await once(renderer, CliRenderEvents.DESTROY);
      }
    } finally {
      if (this.onSigInt) {
        process.off("SIGINT", this.onSigInt);
      }
      if (this.onSigTerm) {
        process.off("SIGTERM", this.onSigTerm);
      }

      if (!renderer.isDestroyed) {
        renderer.destroy();
      }
      this.renderer = null;
      this.conversationList = null;
      this.input = null;
      this.pendingAgentMessage = null;
      this.activeQuery = false;
      this.abortingQuery = false;
      this.shuttingDown = true;
    }

    this.platformLogger.info("Console platform stopped");
  }

  async stop(): Promise<void> {
    this.shutdown("SIGTERM");
  }

  async sendMessage(
    content: string,
    isPartial: boolean,
    options?: OutboundMessageOptions,
  ): Promise<void> {
    if (!this.renderer || !this.conversationList) {
      return;
    }

    if (
      options?.reason === "proactive" &&
      options.target &&
      options.target.platform !== this.type
    ) {
      if (!isPartial) {
        this.addMessage(
          "agent",
          `Proactive message sent to ${this.formatOutboundTarget(options.target)}.`,
        );
      }
      return;
    }

    if (!this.pendingAgentMessage) {
      this.pendingAgentMessage = this.addMessage("agent", "");
    }

    this.pendingAgentMessage.content = content;
    this.scrollConversation();
    this.renderer.requestRender();

    if (!isPartial) {
      this.pendingAgentMessage = null;
      this.activeQuery = false;
      this.abortingQuery = false;
    }
  }

  async sendStats(stats: string): Promise<void> {
    this.addMessage("agent", `[stats] ${stats}`);
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

    if (this.renderer && !this.renderer.isDestroyed) {
      this.renderer.destroy();
    }
  }

  private addMessage(role: "user" | "agent", content: string): TextRenderable {
    if (!this.renderer || !this.conversationList) {
      throw new Error("Console renderer not initialized");
    }

    const isUser = role === "user";
    if (isUser) {
      const row = new BoxRenderable(this.renderer, {
        id: `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        width: "100%",
        flexDirection: "column",
        border: true,
        borderStyle: "rounded",
        borderColor: "#7aa2f7",
        backgroundColor: "#2c355b",
        paddingLeft: 1,
        paddingRight: 1,
        marginBottom: 1,
      });
      const text = new TextRenderable(this.renderer, {
        content,
        fg: "#c0caf5",
      });
      row.add(text);
      this.conversationList.add(row);
      this.scrollConversation();
      this.renderer.requestRender();
      return text;
    }

    const isStats = content.trimStart().startsWith("[stats]");
    const text = new TextRenderable(this.renderer, {
      id: `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      content,
      fg: isStats ? "#9aa5ce" : "#eef1ff",
      marginBottom: 1,
      attributes: isStats ? TextAttributes.DIM : TextAttributes.NONE,
    });
    this.conversationList.add(text);
    this.scrollConversation();
    this.renderer.requestRender();
    return text;
  }

  private scrollConversation(): void {
    if (!this.conversationList) {
      return;
    }
    this.conversationList.scrollTo({ x: 0, y: this.conversationList.scrollHeight });
  }

  private finishAgentMessage(content: string): void {
    if (!this.pendingAgentMessage && this.renderer && this.conversationList) {
      this.pendingAgentMessage = this.addMessage("agent", "");
    }
    if (!this.pendingAgentMessage || !this.renderer) {
      return;
    }
    this.pendingAgentMessage.content = content;
    this.scrollConversation();
    this.renderer.requestRender();
    this.pendingAgentMessage = null;
    this.activeQuery = false;
    this.abortingQuery = false;
  }

  private formatOutboundTarget(target: OutboundMessageTarget): string {
    return `${target.platform}:${target.channelId}`;
  }
}
