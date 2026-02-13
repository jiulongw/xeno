export type CommandName = "serve" | "console" | "install" | "uninstall" | "init";

export type ParsedArgs = {
  command: CommandName;
  home?: string;
  positionalArg?: string;
};

export function printUsage(): void {
  process.stdout.write(`Usage: xeno <command> [--home <path>]\n
Commands:
  serve        Start long-running service
  console      Run interactive debug console
  init         Create and initialize an agent home directory
  install      Install macOS LaunchAgent
  uninstall    Uninstall macOS LaunchAgent

If --home is omitted, xeno uses default_home from ~/.config/xeno/config.json.\n`);
}

function isCommand(value: string): value is CommandName {
  return (
    value === "serve" ||
    value === "console" ||
    value === "init" ||
    value === "install" ||
    value === "uninstall"
  );
}

export function parseArgs(argv: string[]): ParsedArgs {
  const [commandRaw, ...rest] = argv;

  if (!commandRaw || !isCommand(commandRaw)) {
    printUsage();
    throw new Error("Missing or invalid command.");
  }

  let home: string | undefined;
  let positionalArg: string | undefined;
  const acceptsPositional = commandRaw === "init";

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

    if (acceptsPositional && arg && !arg.startsWith("--") && positionalArg === undefined) {
      positionalArg = arg;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { command: commandRaw, home, positionalArg };
}
