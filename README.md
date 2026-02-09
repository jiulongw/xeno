# xeno

Bun CLI app with two commands:

- `serve`: start a long-running placeholder service with graceful shutdown on `Ctrl-C`/`SIGTERM`
- `console`: start an interactive terminal chat UI backed by Claude Agent SDK streaming

Both commands require `--home <string>`.

## Home directory bootstrap

Before running either command, xeno creates `--home` (if needed) and initializes missing files:

- `CLAUDE.md`
- `BOOTSTRAP.md`
- `HEARTBEAT.md`
- `IDENTITY.md`
- `MEMORY.md`
- `SOUL.md`
- `TOOLS.md`
- `USER.md`
- `.claude/settings.local.json`
- `memory/` directory

Existing files are preserved.

## Install

```bash
bun install
```

## Build

```bash
bun run bundle
```

Build output:

- `bin/xeno.js`

## Run from source

```bash
bun run src/index.ts serve --home /tmp/xeno
bun run src/index.ts console --home /tmp/xeno
```

## Logging

Structured logs use `pino`. Set `LOG_LEVEL` to control verbosity:

```bash
LOG_LEVEL=debug bun run src/index.ts serve --home /tmp/xeno
```
