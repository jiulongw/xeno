# xeno

A personal AI agent runtime for macOS. Inspired by [OpenClaw](https://github.com/nickclaw/openclaw), xeno takes a simpler approach: it runs as a lightweight wrapper around [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and focuses on doing one thing well — keeping a persistent, autonomous agent running on your Mac.

xeno requires a pre-authorized Claude Code installation with credentials stored in the macOS Keychain. It ships with pre-installed skills that use AppleScript to access essential macOS apps such as Mail, Calendar, Notes, Reminders, and more.

## Installation

### 1. Install xeno

```bash
brew install jiulongw/tap/xeno
```

### 2. Create an agent home directory

The home directory is where xeno stores the agent's configuration, memory, and skills. Choose a path and run:

```bash
xeno create-home ~/xeno-home
```

This scaffolds the directory with default template files (prompt files, skill definitions, and Claude settings). Existing files are never overwritten.

### 3. Configure xeno

The previous step created a configuration file at `~/.config/xeno/config.json` with `default_home` already pointing to your agent home directory. Edit it to add your Telegram bot token:

```json
{
  "default_home": "~/xeno-home",
  "telegram_bot_token": "YOUR_BOT_TOKEN",
  "telegram_allowed_users": ["YOUR_USER_ID"],
  "heartbeat_interval_minutes": 30,
  "heartbeat_enabled": true
}
```

- `default_home` — path to the agent home directory (set automatically by `create-home`).
- `telegram_bot_token` — token for the Telegram bot that xeno uses as its chat interface.
- `telegram_allowed_users` — array of Telegram user ID strings allowed to interact with the bot. Only listed users can send messages; all others are rejected.
- `heartbeat_interval_minutes` — interval in minutes between heartbeat runs (default: `30`).
- `heartbeat_enabled` — set to `false` to disable the built-in heartbeat task (default: `true`).

#### Obtaining a Telegram bot token

1. Open Telegram and search for [@BotFather](https://t.me/BotFather).
2. Send `/newbot` and follow the prompts to choose a name and username.
3. BotFather will reply with an API token (e.g., `123456:ABC-DEF...`). Copy this value into your config file.
4. To get your Telegram user ID, send a message to your bot. If the service is not installed yet, run `xeno serve` manually so the gateway can receive Telegram messages. If your ID is not listed in `telegram_allowed_users`, the bot replies with your user ID so you can add it to the config.

### 4. Install the LaunchAgent

```bash
xeno install
```

This registers xeno as a macOS LaunchAgent (`cc.novacore.xeno.gateway`) so that it starts automatically when you log in. An active login session is required — xeno will not start after a reboot until you log in for the first time, since it runs as a LaunchAgent rather than a LaunchDaemon.

Run `xeno install` again whenever you change the configuration file to pick up the new settings.

### 5. Upgrading

When you upgrade xeno to a new version:

```bash
brew upgrade xeno
xeno install
```

Always run `xeno install` after upgrading to restart the service with the new binary.

### Uninstalling

To stop the service and remove the LaunchAgent:

```bash
xeno uninstall
```

## Commands

- `serve` — start the gateway service (enables configured chat services such as Telegram), start cron scheduling (including heartbeat), and host a Unix socket JSON-RPC endpoint
- `console` — attach an interactive terminal chat console to a running `serve` process via Unix socket JSON-RPC (`/hb` triggers heartbeat immediately)
- `create-home <path>` — create and initialize an agent home directory
- `install` — install and start a macOS LaunchAgent for `xeno serve`
- `uninstall` — stop and remove the macOS LaunchAgent

`--home <string>` is optional. If omitted, xeno uses `default_home` from `~/.config/xeno/config.json`. Resolved home paths are normalized to absolute paths.

## Home directory

The agent home directory contains the following files (scaffolded from templates on first creation):

- `CLAUDE.md`, `BOOTSTRAP.md`, `HEARTBEAT.md`, `IDENTITY.md`, `MEMORY.md`, `SOUL.md`, `TOOLS.md`, `USER.md`
- `.claude/settings.local.json`
- `.claude/skills/heartbeat/SKILL.md`
- `.claude/skills/run-cron-task/SKILL.md`
- `.claude/skills/xeno-voice/SKILL.md` (with `scripts/xeno-voice`)
- `memory/` directory

Existing files are preserved when re-running `create-home` or starting the service.

## Development

### Install dependencies

```bash
bun install
```

### Build

```bash
bun run bundle
```

Build output:

- `bin/xeno.js`

### Run from source

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
