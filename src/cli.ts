export type CommandName = "serve" | "console";

export type ParsedArgs = {
  command: CommandName;
  home?: string;
};

export function printUsage(): void {
  process.stdout.write(`Usage: xeno <command> [--home <path>]\n
Commands:
  serve      Start long-running service
  console    Run interactive debug console

If --home is omitted, xeno uses default_home from ~/.config/xeno/config.json.\n`);
}

function isCommand(value: string): value is CommandName {
  return value === "serve" || value === "console";
}

export function parseArgs(argv: string[]): ParsedArgs {
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

  return { command: commandRaw, home };
}
