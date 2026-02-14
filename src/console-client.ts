import { once } from "node:events";
import { createInterface } from "node:readline";

import { GatewayRpcClient } from "./ipc/gateway-rpc";
import { logger } from "./logger";
import type { Attachment } from "./media";

const CONSOLE_CHANNEL_ID = "default";
const PROMPT = "> ";

export async function runConsoleClient(home: string): Promise<void> {
  const rpcClient = new GatewayRpcClient(home, { clientName: "console" });
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
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
  let readlineClosed = false;

  let activeQuery = false;
  let abortingQuery = false;
  let shuttingDown = false;

  const printLine = (line: string): void => {
    if (readlineClosed) {
      return;
    }

    const safeLine = line.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
    const promptPrefix = readline.getPrompt() || PROMPT;
    const typed = readline.line;

    process.stdout.write("\r");
    process.stdout.write(`${" ".repeat(promptPrefix.length + typed.length)}\r`);
    process.stdout.write(`${safeLine}\n`);

    if (!shuttingDown && !activeQuery) {
      readline.prompt();
    }
  };

  const addMessage = (role: "user" | "agent", content: string): void => {
    const label = role === "user" ? "you" : "agent";
    printLine(`[${label}] ${content}`);
  };

  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    void rpcClient.abort().catch(() => undefined);
    rpcClient.close();
    platformLogger.info({ signal }, "Console client shutdown");
    readline.close();
  };

  const handleInterrupt = (source: "SIGINT" | "SIGTERM" | "keypress"): void => {
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

  const handleTaskTrigger = async (options: {
    startMessage: string;
    okPrefix: string;
    unavailablePrefix: string;
    statsLabel: string;
    trigger: () => Promise<{
      ok: boolean;
      message: string;
      result?: string;
      durationMs?: number;
    }>;
  }): Promise<void> => {
    addMessage("agent", options.startMessage);
    activeQuery = true;
    abortingQuery = false;

    try {
      const response = await options.trigger();
      const body = response.result?.trim();
      const message =
        response.ok && body
          ? `${options.okPrefix}\n${body}`
          : response.ok
            ? response.message
            : `${options.unavailablePrefix}: ${response.message}`;
      addMessage("agent", message);

      if (response.ok && typeof response.durationMs === "number") {
        const seconds = (response.durationMs / 1000).toFixed(2);
        addMessage("agent", `[stats] ${options.statsLabel} duration=${seconds}s`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      addMessage("agent", `Error: ${message}`);
      platformLogger.error({ error, trigger: options.statsLabel }, "Console trigger failed");
    } finally {
      activeQuery = false;
      abortingQuery = false;
      if (!shuttingDown) {
        readline.prompt();
      }
    }
  };

  const handleQuery = async (userInput: string): Promise<void> => {
    addMessage("user", userInput);
    activeQuery = true;
    abortingQuery = false;

    let sawResponse = false;
    let latestResponse = "";

    try {
      await rpcClient.query(
        userInput,
        {
          channelId: CONSOLE_CHANNEL_ID,
          metadata: { home },
        },
        {
          onStream: (content, isPartial, attachments) => {
            sawResponse = true;
            latestResponse = content;

            if (!isPartial) {
              addMessage("agent", latestResponse || "[No response]");
              printAttachments(attachments, addMessage);
            }
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
        addMessage("agent", "[No response]");
      }

      if (!shuttingDown) {
        readline.prompt();
      }
    }
  };

  try {
    readline.setPrompt(PROMPT);

    if (snapshot.sessionId) {
      addMessage("agent", `Resuming session: ${snapshot.sessionId}`);
      if (snapshot.history.length > 0) {
        addMessage("agent", "[stats] Loaded conversation history.");
        for (const turn of snapshot.history) {
          addMessage(turn.role === "assistant" ? "agent" : "user", turn.content);
        }
      }
    }

    readline.on("line", (line) => {
      const userInput = line.trim();
      if (!userInput || shuttingDown) {
        if (!shuttingDown) {
          readline.prompt();
        }
        return;
      }

      if (activeQuery) {
        addMessage("agent", "A request is already running. Press Ctrl-C to abort it.");
        return;
      }

      if (userInput === "/hb") {
        void handleTaskTrigger({
          startMessage: "Running heartbeat...",
          okPrefix: "[heartbeat]",
          unavailablePrefix: "Heartbeat unavailable",
          statsLabel: "heartbeat",
          trigger: () => rpcClient.heartbeat(),
        });
        return;
      }

      if (userInput === "/new") {
        void handleTaskTrigger({
          startMessage: "Running new session task...",
          okPrefix: "[new-session]",
          unavailablePrefix: "New session task unavailable",
          statsLabel: "new-session",
          trigger: () => rpcClient.newSession(),
        });
        return;
      }

      void handleQuery(userInput);
    });

    readline.on("close", () => {
      readlineClosed = true;
      if (!shuttingDown) {
        shutdown("SIGTERM");
      }
    });

    readline.prompt();
    await once(readline, "close");
  } finally {
    process.off("SIGINT", onSigInt);
    process.off("SIGTERM", onSigTerm);
    rpcClient.close();

    if (!readlineClosed) {
      readline.close();
    }
  }
}

function printAttachments(
  attachments: Attachment[] | undefined,
  addMessage: (role: "user" | "agent", content: string) => void,
): void {
  if (!attachments || attachments.length === 0) {
    return;
  }

  for (const attachment of attachments) {
    const label = attachment.fileName?.trim() || attachment.type;
    addMessage("agent", `[attachment: ${label}] ${attachment.path}`);
  }
}
