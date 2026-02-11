# xeno

Bun CLI app with commands:

- `serve`: start the gateway service (enables configured chat services such as Telegram), start cron scheduling (including heartbeat), and host a Unix socket JSON-RPC endpoint
- `console`: attach a simple interactive terminal chat console to a running gateway via Unix socket JSON-RPC, with a bottom input prompt (`/hb` runs heartbeat immediately)
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
- `.claude/skills/heartbeat/SKILL.md`
- `.claude/skills/run-cron-task/SKILL.md`
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
- Sending `/start` initializes bot commands for the chat (currently `/compact`)
- Telegram `/compact` is forwarded as a raw slash command and bypasses platform-context wrapping
- Non-command Telegram messages include sender name context (`first_name`, fallback `username`) when passed to the agent

## Cron and heartbeat

- `serve` starts a cron engine and exposes cron task management to the agent via MCP server `xeno-cron`
- Available cron MCP tools: `create_cron_task`, `list_cron_tasks`, `update_cron_task`, `delete_cron_task`
- Cron and heartbeat runs execute through the gateway agent runtime (cron runs are prefixed as `/run-cron-task task_id:<task_id> now:<iso_timestamp>`, heartbeat runs as `/heartbeat now:<iso_timestamp>`)
- During cron execution, xeno injects MCP server `xeno-messenger` with tool `send_message` so tasks can send proactive messages (default target: last known channel)
- Cron task `notify` modes are `auto` and `never`
- Cron task model selection is not user-configurable; runs use the internal default model
- Cron engine result callbacks are currently not auto-broadcast to chat channels
- Persistent cron tasks are stored at `<home>/cron-tasks.json`
- Built-in heartbeat task:
  - Reads `HEARTBEAT.md`
  - Runs every 30 minutes by default
  - Is runtime-only (not persisted in `cron-tasks.json`)
  - Can be triggered manually from console with `/hb` or via JSON-RPC `gateway.heartbeat`

## Config file

Path: `~/.config/xeno/config.json`

Example:

```json
{
  "default_home": "/tmp/xeno",
  "telegram_bot_token": "123456:abcdef",
  "heartbeat_interval_minutes": 30,
  "heartbeat_enabled": true
}
```

Heartbeat config keys are optional:

- `heartbeat_interval_minutes` (number): interval for built-in heartbeat task
- `heartbeat_enabled` (boolean): enable/disable built-in heartbeat task (default `true`)

## Claude executable override

Set `PATH_TO_CLAUDE_CODE_EXECUTABLE` to override the Claude CLI path used by the agent.
If unset, the Claude Agent SDK default executable resolution is used.

## Logging

Structured logs use `pino`. Set `LOG_LEVEL` to control verbosity:

```bash
LOG_LEVEL=debug bun run src/index.ts serve --home /tmp/xeno
```

Telegram inbound messages are logged at `info` with metadata including user/chat IDs, message type, detected slash command, attachment count, and short text/caption previews.

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
