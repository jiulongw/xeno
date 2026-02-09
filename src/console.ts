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
import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

import { Agent } from "./agent";
import { logger } from "./logger";

export async function runConsole(home: string): Promise<void> {
  logger.info({ home }, "Console mode");
  const agent = new Agent(home);

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
    } else {
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
    }
  };

  const asRecord = (value: unknown): Record<string, unknown> | null => {
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  };

  const extractAssistantText = (message: SDKMessage): string => {
    if (message.type === "assistant") {
      const maybeContent = (message.message as { content?: unknown }).content;
      if (!Array.isArray(maybeContent)) {
        return "";
      }

      let text = "";
      for (const block of maybeContent) {
        const record = asRecord(block);
        if (!record || record.type !== "text") {
          continue;
        }
        const blockText = record.text;
        if (typeof blockText === "string") {
          text += blockText;
        }
      }
      return text;
    }

    if (message.type !== "stream_event") {
      return "";
    }

    const event = asRecord(message.event);
    if (!event) {
      return "";
    }

    if (event.type === "content_block_start") {
      const block = asRecord(event.content_block);
      if (block?.type === "text" && typeof block.text === "string") {
        return block.text;
      }
      return "";
    }

    if (event.type === "content_block_delta") {
      const delta = asRecord(event.delta);
      if (delta?.type === "text_delta" && typeof delta.text === "string") {
        return delta.text;
      }
      return "";
    }

    return "";
  };

  const formatResultStats = (result: SDKResultMessage): string => {
    const durationSec = (result.duration_ms / 1000).toFixed(2);
    const apiDurationSec = (result.duration_api_ms / 1000).toFixed(2);
    const cost = result.total_cost_usd.toFixed(6);

    return [
      `result=${result.subtype}`,
      `turns=${result.num_turns}`,
      `cost=$${cost}`,
      `duration=${durationSec}s`,
      `api=${apiDurationSec}s`,
      `stop=${result.stop_reason ?? "none"}`,
    ].join(" | ");
  };

  const isLoginRequiredError = (message: string): boolean => {
    const lower = message.toLowerCase();
    return (
      lower.includes("not logged in") ||
      lower.includes("please log in") ||
      lower.includes("please login") ||
      lower.includes("authentication") ||
      lower.includes("unauthorized") ||
      lower.includes("401")
    );
  };

  let activeQuery = false;
  let abortingQuery = false;

  const handleInterrupt = (source: "SIGINT" | "SIGTERM" | "keypress") => {
    if (activeQuery) {
      if (!abortingQuery) {
        abortingQuery = true;
        addMessage("agent", "Aborting current request...");
        logger.info({ source }, "Aborting active query");
        agent.abort();
      } else {
        shutdown(source === "SIGTERM" ? "SIGTERM" : "SIGINT");
      }
      return;
    }

    shutdown(source === "SIGTERM" ? "SIGTERM" : "SIGINT");
  };

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    agent.abort();
    logger.info({ signal }, "Console shutdown");
    renderer.destroy();
  };

  const onSigInt = () => handleInterrupt("SIGINT");
  const onSigTerm = () => handleInterrupt("SIGTERM");
  process.on("SIGINT", onSigInt);
  process.on("SIGTERM", onSigTerm);

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
      logger.info({ input: userInput }, "query");
      input.value = "";

      const agentMessage = addMessage("agent", "");
      let streamed = "";
      let fallbackFinal = "";
      activeQuery = true;
      abortingQuery = false;

      try {
        for await (const message of agent.query(userInput, { includePartialMessages: true })) {
          if (shuttingDown) {
            break;
          }

          if (message.type === "stream_event") {
            const delta = extractAssistantText(message);
            if (delta) {
              streamed += delta;
              agentMessage.content = streamed;
              conversationList.scrollTo({ x: 0, y: conversationList.scrollHeight });
              renderer.requestRender();
            }
            continue;
          }

          if (message.type === "assistant") {
            fallbackFinal = extractAssistantText(message);
            if (!streamed && fallbackFinal) {
              agentMessage.content = fallbackFinal;
              conversationList.scrollTo({ x: 0, y: conversationList.scrollHeight });
              renderer.requestRender();
            }
            continue;
          }

          if (message.type === "result") {
            addMessage("agent", `[stats] ${formatResultStats(message)}`);
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const needsLogin = isLoginRequiredError(message);
        const isAbortError =
          message.toLowerCase().includes("aborted") || message.toLowerCase().includes("abort");
        if (!isAbortError) {
          addMessage("agent", `Error: ${message}`);
          logger.error({ error }, "Query failed");
          if (needsLogin) {
            addMessage(
              "agent",
              'Authentication may be blocked by a locked macOS keychain (common in headless SSH sessions). Run "security unlock-keychain" in your terminal and retry.',
            );
          }
        }
      } finally {
        activeQuery = false;
        abortingQuery = false;
        const content = streamed || fallbackFinal;
        if (!content) {
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

    const sessionId = agent.getSessionId();
    if (sessionId) {
      addMessage("agent", `Resuming session: ${sessionId}`);
      const history = await agent.getConversationHistory();
      if (history.length > 0) {
        addMessage("agent", "[stats] Loaded conversation history.");
        for (const turn of history) {
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
    if (!renderer.isDestroyed) {
      renderer.destroy();
    }
  }

  logger.info("Console stopped");
}
