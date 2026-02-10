# xeno

Bun CLI app with commands:

- `serve`: start the gateway service (enables configured chat services such as Telegram) and host a Unix socket JSON-RPC endpoint
- `console`: attach an interactive terminal chat UI to a running gateway via Unix socket JSON-RPC
- `install`: macOS-only command to install and start a LaunchAgent (`cc.novacore.xeno.gateway`) for `xeno serve`, write stdout/stderr logs under `~/.xeno/logs`, and inject Bun's runtime directory into LaunchAgent `PATH`
- `uninstall`: macOS-only command to stop and remove the LaunchAgent (`cc.novacore.xeno.gateway`)

`--home <string>` is optional. If omitted, xeno uses `default_home` from `~/.config/xeno/config.json`. Resolved home paths are normalized to absolute paths.

## Home directory bootstrap

Before running `serve` or `console`, xeno creates the resolved home directory (if needed) and initializes missing files:

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
bun run src/index.ts install --home /tmp/xeno
bun run src/index.ts uninstall
```

`console` requires a running `serve` process for the same `--home`.
Socket path: `<home>/.xeno/gateway.sock`.

## Telegram setup

Set `TELEGRAM_BOT_TOKEN` to enable Telegram service under `serve`.

You can also set `telegram_bot_token` in `~/.config/xeno/config.json`.

- `serve` enables Telegram automatically when a token is available
- `TELEGRAM_BOT_TOKEN` overrides `telegram_bot_token` from config

## Config file

Path: `~/.config/xeno/config.json`

Example:

```json
{
  "default_home": "/tmp/xeno",
  "telegram_bot_token": "123456:abcdef"
}
```

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
    - `bun run test`
- Release workflow: `.github/workflows/release.yml`
  - Triggers on pushed tags matching `v*`
  - Runs `bun run bundle`
  - Copies required Claude Agent SDK runtime files into `bin/` (`cli.js`, `*.wasm`, `vendor/`)
  - Packages build output as `dist/xeno-<tag>.tar.gz`
  - Generates checksum file `dist/xeno-<tag>.tar.gz.sha256`
  - Uploads both files to the GitHub Release for the tag
