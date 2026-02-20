#!/usr/bin/env bun

import { Agent } from "./agent";
import { ChannelMessageQueue } from "./channel/message-queue";
import { ChannelRegistry } from "./channel/registry";
import { ChannelSession } from "./channel/session";
import { MAIN_CHANNEL_KEY } from "./channel/types";
import { TelegramPlatform } from "./chat/platforms/telegram";
import type { ChatService } from "./chat/service";
import { parseArgs } from "./cli";
import { runConsoleClient } from "./console-client";
import {
  getConfigPath,
  loadUserConfig,
  resolveHome,
  resolveTelegramBotToken,
  type AppConfig,
} from "./config";
import { Gateway } from "./gateway";
import { createChannelHome, createHome } from "./home";
import { GatewayRpcServer } from "./ipc/gateway-rpc";
import { getGatewaySocketPath, isGatewaySocketActive } from "./ipc/socket";
import { installLaunchAgent, uninstallLaunchAgent } from "./launch-agent";
import { logger } from "./logger";
import { CronEngine, type CronTaskExecutionResult } from "./cron/engine";
import { createHeartbeatTask } from "./cron/heartbeat";
import { createWeeklyNewSessionTask } from "./cron/new-session";
import { CronStore } from "./cron/store";
import { HEARTBEAT_TASK_ID, WEEKLY_NEW_SESSION_TASK_ID } from "./cron/types";
import { createCronMcpServer } from "./mcp/cron";
import { createMessengerMcpServer } from "./mcp/messenger";

function buildServeServices(home: string, config: AppConfig): ChatService[] {
  const services: ChatService[] = [];
  const telegramToken = resolveTelegramBotToken(config);

  if (telegramToken) {
    services.push(
      new TelegramPlatform({
        home,
        token: telegramToken,
        allowedUserIds: config.telegramAllowedUsers,
      }),
    );
  } else {
    logger.info(
      { configPath: getConfigPath() },
      "Telegram token not set; configure TELEGRAM_BOT_TOKEN or telegram_bot_token",
    );
  }

  return services;
}

async function runServe(home: string, config: AppConfig): Promise<void> {
  const socketPath = getGatewaySocketPath(home);
  const running = await isGatewaySocketActive(home);
  if (running) {
    throw new Error(`Gateway service is already running for home ${home} (socket: ${socketPath}).`);
  }

  const agent = new Agent(home);
  const mainSession = new ChannelSession(MAIN_CHANNEL_KEY, agent);
  const channelRegistry = new ChannelRegistry({
    home,
    mainSession,
    createTopicSession: async (channelKey, channelName) => {
      const channelDir = await createChannelHome(home, channelKey, channelName);
      const topicAgent = new Agent(channelDir, { defaultModel: "sonnet", parentHome: home });
      const messageQueue = new ChannelMessageQueue(channelDir);

      // Per-channel cron engine (no system tasks)
      const channelCronStore = new CronStore(channelDir);
      let channelSession: ChannelSession | null = null;
      const channelCronEngine = new CronEngine({
        home: channelDir,
        store: channelCronStore,
        queryRunner: async (request) => {
          if (!gateway) {
            throw new Error("Gateway is not initialized.");
          }
          if (!channelSession) {
            throw new Error("Channel session is not initialized.");
          }
          return gateway.runCronQuery({
            ...request,
            session: channelSession,
            mcpServers: {
              "xeno-messenger": messengerMcpServer,
            },
          });
        },
        onResult: async (result) => {
          logger.info({ channelKey, result }, "Channel cron task result");
        },
      });
      const channelCronMcpServer = createCronMcpServer(channelCronEngine);

      channelSession = new ChannelSession(channelKey, topicAgent, {
        messageQueue,
        cronEngine: channelCronEngine,
        mcpServers: { "xeno-cron": channelCronMcpServer },
      });

      await channelCronEngine.start();
      return channelSession;
    },
  });

  const cronStore = new CronStore(home);
  const heartbeatEnabled = config.heartbeatEnabled ?? true;
  let gateway: Gateway | null = null;
  const messengerMcpServer = createMessengerMcpServer({
    sendMessage: async (request) => {
      if (!gateway) {
        throw new Error("Gateway is not initialized.");
      }
      return gateway.sendMessage(request);
    },
  });
  const cronEngine = new CronEngine({
    home,
    store: cronStore,
    heartbeatTask: heartbeatEnabled
      ? createHeartbeatTask({
          intervalMinutes: config.heartbeatIntervalMinutes,
          enabled: heartbeatEnabled,
        })
      : undefined,
    systemTasks: [createWeeklyNewSessionTask()],
    queryRunner: async (request) => {
      if (!gateway) {
        throw new Error("Gateway is not initialized.");
      }
      if (request.taskId === WEEKLY_NEW_SESSION_TASK_ID) {
        logger.info("Saving memory before session end...");
        await gateway.runCronQuery({
          ...request,
          prompt: "Session is about to end. Save your memory now.",
        });

        agent.clearMainSessionId();
      }
      return gateway.runCronQuery({
        ...request,
        mcpServers: {
          "xeno-messenger": messengerMcpServer,
        },
      });
    },
    onResult: async (result) => {
      logger.info({ result }, "Cron task result");
    },
  });
  const cronMcpServer = createCronMcpServer(cronEngine);

  const gatewayInstance = new Gateway({
    home,
    channelRegistry,
    services: buildServeServices(home, config),
    mcpServers: {
      "xeno-cron": cronMcpServer,
    },
    rpcMcpServers: {
      "xeno-messenger": messengerMcpServer,
    },
  });
  gateway = gatewayInstance;
  const rpcServer = new GatewayRpcServer({
    home,
    gateway: gatewayInstance,
    runHeartbeat: async () => {
      const outcome = await cronEngine.runTaskNow(HEARTBEAT_TASK_ID);
      if (!outcome) {
        return {
          ok: false,
          message: "Heartbeat task is unavailable or disabled.",
        };
      }

      return {
        ok: true,
        message: "Heartbeat completed.",
        result: outcome.result,
        durationMs: outcome.durationMs,
      };
    },
    runNewSession: async () => {
      const outcome = await cronEngine.runTaskNow(WEEKLY_NEW_SESSION_TASK_ID);
      if (!outcome) {
        return {
          ok: false,
          message: "New session task is unavailable or disabled.",
        };
      }

      return {
        ok: true,
        message: "New session task completed.",
        result: outcome.result,
        durationMs: outcome.durationMs,
      };
    },
  });

  logger.info({ home }, "Starting service");
  await gatewayInstance.start();
  await cronEngine.start();
  let rpcStarted = false;

  try {
    await rpcServer.start();
    rpcStarted = true;

    const keepAlive = setInterval(() => {
      // Placeholder service loop.
    }, 60_000);

    await new Promise<void>((resolve) => {
      let shuttingDown = false;

      const shutdown = (signal: NodeJS.Signals) => {
        if (shuttingDown) {
          return;
        }
        shuttingDown = true;
        logger.info({ signal }, "Shutting down service");
        clearInterval(keepAlive);
        resolve();
      };

      process.once("SIGINT", () => {
        shutdown("SIGINT");
      });
      process.once("SIGTERM", () => {
        shutdown("SIGTERM");
      });
    });
  } finally {
    if (rpcStarted) {
      await rpcServer.stop();
    }
    await cronEngine.stop();
    await gatewayInstance.stop();
  }

  logger.info("Service stopped");
}

async function runConsole(home: string): Promise<void> {
  logger.info({ home }, "Console attach mode");
  await runConsoleClient(home);
}

async function runInstall(home: string): Promise<void> {
  const result = await installLaunchAgent({
    home,
    executablePath: process.argv[1],
    cwd: process.cwd(),
    runtimePath: process.execPath,
    pathEnv: process.env.PATH,
  });
  process.stdout.write(
    `Installed LaunchAgent ${result.label} at ${result.plistPath} (entrypoint: ${result.executablePath}; stdout: ${result.stdoutPath}; stderr: ${result.stderrPath}).\n`,
  );
}

async function runCreateHome(home: string): Promise<void> {
  await createHome(home);
  process.stdout.write(`Home directory initialized at ${home}\n`);
}

async function runUninstall(): Promise<void> {
  const result = await uninstallLaunchAgent();
  process.stdout.write(`Uninstalled LaunchAgent ${result.label} from ${result.plistPath}.\n`);
}

async function main(): Promise<void> {
  try {
    const { command, home: homeFromArgs, positionalArg } = parseArgs(process.argv.slice(2));

    if (command === "init") {
      const target = positionalArg || homeFromArgs;
      if (!target) {
        throw new Error("Usage: xeno init <path>");
      }
      const { resolve } = await import("node:path");
      await runCreateHome(resolve(target));
      return;
    }

    if (command === "install") {
      const config = await loadUserConfig();
      const home = resolveHome(homeFromArgs, config);
      await runInstall(home);
      return;
    }

    if (command === "uninstall") {
      await runUninstall();
      return;
    }

    const config = await loadUserConfig();
    const home = resolveHome(homeFromArgs, config);
    await createHome(home);

    if (command === "serve") {
      await runServe(home, config);
      return;
    }

    if (command === "console") {
      await runConsole(home);
      return;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

void main();
