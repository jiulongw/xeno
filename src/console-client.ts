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
  type KeyEvent,
} from "@opentui/core";

import { GatewayRpcClient } from "./ipc/gateway-rpc";
import { logger } from "./logger";

export async function runConsoleClient(home: string): Promise<void> {
  const rpcClient = new GatewayRpcClient(home);
  const platformLogger = logger.child({ service: "console-client", home });

  try {
    await rpcClient.connect();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Unable to connect to running gateway service for home ${home}. Start serve first. (${message})`,
    );
  }

  const snapshot = await rpcClient.initialize();

  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
  });

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

  const addMessage = (role: "user" | "agent", content: string): TextRenderable => {
    const isUser = role === "user";
    if (isUser) {
      const row = new BoxRenderable(renderer, {
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
      const text = new TextRenderable(renderer, {
        content,
        fg: "#c0caf5",
      });
      row.add(text);
      conversationList.add(row);
      conversationList.scrollTo({ x: 0, y: conversationList.scrollHeight });
      renderer.requestRender();
      return text;
    }

    const isStats = content.trimStart().startsWith("[stats]");
    const text = new TextRenderable(renderer, {
      id: `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      content,
      fg: isStats ? "#9aa5ce" : "#eef1ff",
      marginBottom: 1,
      attributes: isStats ? TextAttributes.DIM : TextAttributes.NONE,
    });
    conversationList.add(text);
    conversationList.scrollTo({ x: 0, y: conversationList.scrollHeight });
    renderer.requestRender();
    return text;
  };

  let activeQuery = false;
  let abortingQuery = false;
  let shuttingDown = false;

  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    void rpcClient.abort().catch(() => undefined);
    rpcClient.close();
    platformLogger.info({ signal }, "Console client shutdown");
    if (!renderer.isDestroyed) {
      renderer.destroy();
    }
  };

  const handleInterrupt = (source: "SIGINT" | "SIGTERM" | "keypress") => {
    if (activeQuery) {
      if (!abortingQuery) {
        abortingQuery = true;
        addMessage("agent", "Aborting current request...");
        platformLogger.info({ source }, "Aborting active query");
        void rpcClient.abort();
      } else {
        shutdown(source === "SIGTERM" ? "SIGTERM" : "SIGINT");
      }
      return;
    }

    shutdown(source === "SIGTERM" ? "SIGTERM" : "SIGINT");
  };

  const onSigInt = () => handleInterrupt("SIGINT");
  const onSigTerm = () => handleInterrupt("SIGTERM");
  process.on("SIGINT", onSigInt);
  process.on("SIGTERM", onSigTerm);

  rpcClient.setDisconnectedHandler(() => {
    if (shuttingDown) {
      return;
    }
    addMessage("agent", "Disconnected from gateway service.");
    shutdown("SIGTERM");
  });

  try {
    input.on(InputRenderableEvents.ENTER, async () => {
      const userInput = input.value.trim();
      if (!userInput) {
        return;
      }
      if (activeQuery) {
        addMessage("agent", "A request is already running. Press Ctrl-C to abort it.");
        return;
      }

      addMessage("user", userInput);
      input.value = "";

      const agentMessage = addMessage("agent", "");
      let sawResponse = false;
      activeQuery = true;
      abortingQuery = false;

      try {
        await rpcClient.query(
          userInput,
          {
            type: "console",
            metadata: { home },
          },
          {
            onStream: (content) => {
              sawResponse = true;
              agentMessage.content = content;
              conversationList.scrollTo({ x: 0, y: conversationList.scrollHeight });
              renderer.requestRender();
            },
            onStats: (stats) => {
              addMessage("agent", `[stats] ${stats}`);
            },
          },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const isAbortError =
          message.toLowerCase().includes("aborted") || message.toLowerCase().includes("abort");
        if (!isAbortError) {
          addMessage("agent", `Error: ${message}`);
          platformLogger.error({ error }, "Console query failed");
        }
      } finally {
        activeQuery = false;
        abortingQuery = false;
        if (!sawResponse) {
          agentMessage.content = "[No response]";
          renderer.requestRender();
        }
      }
    });

    renderer.keyInput.on("keypress", (key: KeyEvent) => {
      if (key.ctrl && key.name === "c") {
        handleInterrupt("keypress");
      }
    });

    app.add(conversationList);
    inputBar.add(input);
    app.add(inputBar);
    renderer.root.add(app);
    input.focus();
    renderer.start();

    if (snapshot.sessionId) {
      addMessage("agent", `Resuming session: ${snapshot.sessionId}`);
      if (snapshot.history.length > 0) {
        addMessage("agent", "[stats] Loaded conversation history.");
        for (const turn of snapshot.history) {
          addMessage(turn.role === "assistant" ? "agent" : "user", turn.content);
        }
      }
    }

    if (!renderer.isDestroyed) {
      await once(renderer, CliRenderEvents.DESTROY);
    }
  } finally {
    process.off("SIGINT", onSigInt);
    process.off("SIGTERM", onSigTerm);
    rpcClient.close();
    if (!renderer.isDestroyed) {
      renderer.destroy();
    }
  }
}
