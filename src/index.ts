#!/usr/bin/env bun

import { createInterface } from "node:readline";
import { once } from "node:events";

type CommandName = "serve" | "console";

type ParsedArgs = {
  command: CommandName;
  home: string;
};

function printUsage(): void {
  console.log(`Usage: xeno <command> --home <path>\n
Commands:
  serve      Start long-running service
  console    Run interactive debug console`);
}

function parseArgs(argv: string[]): ParsedArgs {
  const [commandRaw, ...rest] = argv;

  if (!commandRaw || !isCommand(commandRaw)) {
    printUsage();
    throw new Error("Missing or invalid command.");
  }

  let home: string | undefined;

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--home") {
      const value = rest[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--home requires a string value.");
      }
      home = value;
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!home) {
    throw new Error("Missing required --home parameter.");
  }

  return { command: commandRaw, home };
}

function isCommand(value: string): value is CommandName {
  return value === "serve" || value === "console";
}

async function runServe(home: string): Promise<void> {
  console.log(`Starting service (home: ${home})`);

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
      console.log("Shutting down service...");
      clearInterval(keepAlive);
      resolve();
    };

    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });

  console.log("Service stopped.");
}

async function runConsole(home: string): Promise<void> {
  console.log(`Console mode (home: ${home})`);

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  const shutdown = () => {
    console.log("\nConsole shutdown...");
    rl.close();
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  try {
    rl.setPrompt("> ");
    rl.prompt();
    rl.on("line", (input) => {
      console.log(`echo: ${input}`);
      rl.prompt();
    });
    await once(rl, "close");
  } finally {
    rl.close();
  }

  console.log("Console stopped.");
}

async function main(): Promise<void> {
  try {
    const { command, home } = parseArgs(process.argv.slice(2));

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
    console.error(message);
    process.exitCode = 1;
  }
}

void main();
