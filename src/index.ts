#!/usr/bin/env bun

import { Agent } from "./agent";
import { TelegramPlatform } from "./chat/platforms/telegram";
import type { ChatService } from "./chat/service";
import { parseArgs } from "./cli";
import { runConsoleClient } from "./console-client";
import { Gateway } from "./gateway";
import { createHome } from "./home";
import { GatewayRpcServer } from "./ipc/gateway-rpc";
import { logger } from "./logger";

function buildServeServices(home: string): ChatService[] {
  const services: ChatService[] = [];
  const telegramToken = process.env.TELEGRAM_BOT_TOKEN;

  if (telegramToken) {
    services.push(new TelegramPlatform({ home, token: telegramToken }));
  } else {
    logger.info("TELEGRAM_BOT_TOKEN is not set; Telegram platform disabled");
  }

  return services;
}

async function runServe(home: string): Promise<void> {
  const agent = new Agent(home);
  const gateway = new Gateway({
    home,
    agent,
    services: buildServeServices(home),
  });
  const rpcServer = new GatewayRpcServer({
    home,
    gateway,
  });

  logger.info({ home }, "Starting service");
  await gateway.start();
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
    await gateway.stop();
  }

  logger.info("Service stopped");
}

async function runConsole(home: string): Promise<void> {
  logger.info({ home }, "Console attach mode");
  await runConsoleClient(home);
}

async function main(): Promise<void> {
  try {
    const { command, home } = parseArgs(process.argv.slice(2));
    await createHome(home);

    if (command === "serve") {
      await runServe(home);
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
