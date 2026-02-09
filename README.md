# xeno

Bun CLI app with two commands:

- `serve`: start the gateway service (enables configured chat services such as Telegram) and host a Unix socket JSON-RPC endpoint
- `console`: attach an interactive terminal chat UI to a running gateway via Unix socket JSON-RPC

All commands require `--home <string>`.

## Home directory bootstrap

Before running any command, xeno creates `--home` (if needed) and initializes missing files:

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

`console` requires a running `serve` process for the same `--home`.
Socket path: `<home>/.xeno/gateway.sock`.

## Telegram setup

Set `TELEGRAM_BOT_TOKEN` to enable Telegram service under `serve`.

- `serve` enables Telegram automatically when `TELEGRAM_BOT_TOKEN` is set

## Claude executable override

Set `PATH_TO_CLAUDE_CODE_EXECUTABLE` to override the Claude CLI path used by the agent.
If unset, the Claude Agent SDK default executable resolution is used.

## Logging

Structured logs use `pino`. Set `LOG_LEVEL` to control verbosity:

```bash
LOG_LEVEL=debug bun run src/index.ts serve --home /tmp/xeno
```

## Known edge case

In headless SSH sessions, first-time authentication can fail if the macOS keychain is locked. If needed, run `security unlock-keychain` and retry.

Claude authentication failures can sometimes appear in output (for example, `Not logged in · Please run /login`) while the SDK result stats still report `result=success`. This is an upstream edge case, so xeno currently displays both as-is across modes.

## GitHub Actions

- CI workflow: `.github/workflows/ci.yml`
  - Triggers on `pull_request` and `push` to `main`
  - Runs:
    - `bun install --frozen-lockfile`
    - `bunx prettier --check .`
    - `bun run check`
- Release workflow: `.github/workflows/release.yml`
  - Triggers on pushed tags matching `v*`
  - Runs `bun run bundle`
  - Copies required Claude Agent SDK runtime files into `bin/` (`cli.js`, `*.wasm`, `vendor/`)
  - Packages build output as `dist/xeno-<tag>.tar.gz`
  - Generates checksum file `dist/xeno-<tag>.tar.gz.sha256`
  - Uploads both files to the GitHub Release for the tag
