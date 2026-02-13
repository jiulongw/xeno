# AGENTS

## Runtime and package manager

- Use Bun for everything in this repo.
- Use `bun install`, `bun run <script>`, `bun test`, and `bun run bundle`.
- Prefer Bun built-in APIs and Bun-supported primitives before adding third-party dependencies.

## Current CLI setup

- Entry point: `src/index.ts`
- Commands:
  - `serve`: runs the gateway service and Unix domain socket JSON-RPC endpoint at `<home>/.xeno/gateway.sock`, starts the cron engine, and supports graceful shutdown on `Ctrl-C`/`SIGTERM`
  - `console`: interactive terminal chat console that attaches to a running `serve` process over JSON-RPC, keeps a simple bottom input prompt, supports graceful shutdown on `Ctrl-C`/`SIGTERM`, abort support, and `/hb` to trigger heartbeat immediately
  - `create-home <path>`: creates and initializes an agent home directory at the given path, scaffolding template files without overwriting existing ones
  - `install`: macOS-only command that writes `~/Library/LaunchAgents/cc.novacore.xeno.gateway.plist` and loads it via `launchctl` to run `xeno serve` (entrypoint resolved from the running program path at install time); stdout/stderr are written to timestamped files under `~/.xeno/logs`; plist `EnvironmentVariables.PATH` includes Bun runtime directory
  - `uninstall`: macOS-only command that unloads and removes `~/Library/LaunchAgents/cc.novacore.xeno.gateway.plist`
- `--home <string>` is optional. If omitted, `default_home` from `~/.config/xeno/config.json` is used. The resolved home path is normalized to an absolute path.
- `serve` enables Telegram chat service automatically when a token is configured:
  - `TELEGRAM_BOT_TOKEN` environment variable (highest precedence)
  - `telegram_bot_token` in `~/.config/xeno/config.json`
  - Telegram `/start` initializes bot commands (currently `/compact`)
  - Telegram `/compact` is forwarded as raw `/compact` and bypasses platform context wrapping
  - Other Telegram messages include sender display context (`first_name`, fallback `username`)
- `serve` also supports heartbeat config from `~/.config/xeno/config.json`:
  - `heartbeat_interval_minutes` (number, optional)
  - `heartbeat_enabled` (boolean, optional; defaults to `true`)

## Cron and heartbeat

- Runtime dependency: `node-cron`
- Cron engine: `src/cron/engine.ts`
  - Loads persisted tasks from `<home>/cron-tasks.json` via `src/cron/store.ts`
  - Supports `interval`, `once`, and `cron_expression` schedules
  - `notify` supports `auto` and `never` (`always` is not supported)
  - Cron runs are executed via `Gateway.runCronQuery` and prompt-prefixed as `/run-cron-task task_id:<task_id> now:<iso_timestamp>`
  - Cron task model selection is not user-configurable; runs use `CRON_DEFAULT_MODEL` (`haiku`)
  - `runServe` currently does not auto-broadcast cron completion results in `onResult`
- Built-in heartbeat task:
  - Factory: `src/cron/heartbeat.ts`
  - Task ID: `__heartbeat__`
  - Uses `/heartbeat now:<iso_timestamp>` prompt prefix at runtime
  - Runtime-only (not persisted to cron store)
  - Triggered on schedule, from console `/hb`, or over RPC `gateway.heartbeat`
- MCP integration:
  - `serve` registers MCP server `xeno-cron` on the gateway (`src/mcp/cron.ts`)
  - Tools: `create_cron_task`, `list_cron_tasks`, `update_cron_task`, `delete_cron_task`
  - Cron runs receive MCP server `xeno-messenger` (`src/mcp/messenger.ts`) with tool `send_message`
- IPC:
  - `src/ipc/gateway-rpc.ts` supports `gateway.heartbeat` request/response (`ok`, `message`, optional `result`, optional `durationMs`)

## Home initialization

- On startup, `serve` and `console` resolve `home` (CLI `--home` override, otherwise config `default_home`) and call `createHome(home)` from `src/home.ts`.
- Missing files are scaffolded from `template/`:
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
  - `.claude/skills/applescript/SKILL.md` (+ `references/calendar.md`, `mail.md`, `notes.md`, `reminders.md`)
  - `.claude/skills/xeno-voice/SKILL.md` (+ `scripts/xeno-voice`)
- `memory/` is created if missing.
- Existing files are never overwritten.

## Logging

- Logger: `src/logger.ts` (`pino`)
- Log level: `LOG_LEVEL` env var (default `info`)
- Telegram inbound logging includes command detection, message/attachment type metadata, and short text/caption previews

## Claude executable path

- Optional env var: `PATH_TO_CLAUDE_CODE_EXECUTABLE`
- When set, `src/agent.ts` passes this value to `pathToClaudeCodeExecutable`.
- No `bun.which("claude")` lookup is used.

## Build output

- Build command: `bun run bundle`
- Binary output: `bin/xeno.js` (via `bun build --outdir ./bin --entry-naming xeno.js`)

## GitHub workflows

- CI workflow: `.github/workflows/ci.yml`
  - Trigger: `pull_request` and `push` to `main`
  - Steps: install (`bun install --frozen-lockfile`), format check (`bunx prettier --check .`), type check (`bun run check`), test (`bun run test`)
- Release workflow: `.github/workflows/release.yml`
  - Trigger: pushed tags matching `v*`
  - Steps: build (`bun run bundle`), copy Claude Agent SDK runtime files into `bin/` (`cli.js`, `*.wasm`, `vendor/`), package `bin/` into `dist/xeno-<tag>.tar.gz`, generate `dist/xeno-<tag>.tar.gz.sha256`, upload both assets to the tag's GitHub Release
