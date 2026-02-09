# AGENTS

## Runtime and package manager

- Use Bun for everything in this repo.
- Use `bun install`, `bun run <script>`, `bun test`, and `bun run bundle`.
- Prefer Bun built-in APIs and Bun-supported primitives before adding third-party dependencies.

## Current CLI setup

- Entry point: `src/index.ts`
- Commands:
  - `serve`: runs the gateway service and Unix domain socket JSON-RPC endpoint at `<home>/.xeno/gateway.sock`, graceful shutdown on `Ctrl-C`/`SIGTERM`
  - `console`: interactive OpenTUI chat UI that attaches to a running `serve` process over JSON-RPC, graceful shutdown on `Ctrl-C`/`SIGTERM` and abort support
- `--home <string>` is optional. If omitted, `default_home` from `~/.config/xeno/config.json` is used.
- `serve` enables Telegram chat service automatically when a token is configured:
  - `TELEGRAM_BOT_TOKEN` environment variable (highest precedence)
  - `telegram_bot_token` in `~/.config/xeno/config.json`

## Home initialization

- On startup, both commands resolve `home` (CLI `--home` override, otherwise config `default_home`) and call `createHome(home)` from `src/home.ts`.
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
- `memory/` is created if missing.
- Existing files are never overwritten.

## Logging

- Logger: `src/logger.ts` (`pino`)
- Log level: `LOG_LEVEL` env var (default `info`)

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
