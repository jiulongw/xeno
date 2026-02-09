#!/usr/bin/env bun

import { parseArgs } from "./cli";
import { runConsole } from "./console";
import { createHome } from "./home";
import { logger } from "./logger";

async function runServe(home: string): Promise<void> {
  logger.info({ home }, "Starting service");

  await new Promise<void>((resolve) => {
    let shuttingDown = false;
    const keepAlive = setInterval(() => {
      // Placeholder service loop.
    }, 60_000);

    const shutdown = () => {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      logger.info("Shutting down service");
      clearInterval(keepAlive);
      resolve();
    };

    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });

  logger.info("Service stopped");
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
