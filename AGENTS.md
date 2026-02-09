# AGENTS

## Runtime and package manager

- Use Bun for everything in this repo.
- Use `bun install`, `bun run <script>`, `bun test`, and `bun run bundle`.
- Prefer Bun built-in APIs and Bun-supported primitives before adding third-party dependencies.

## Current CLI setup

- Entry point: `src/index.ts`
- Commands:
  - `serve`: long-running placeholder service, graceful shutdown on `Ctrl-C`/`SIGTERM`
  - `console`: interactive OpenTUI chat UI backed by Claude Agent SDK streaming, graceful shutdown on `Ctrl-C`/`SIGTERM` and abort support
- Both commands require `--home <string>`.

## Home initialization

- On startup, both commands call `createHome(home)` from `src/home.ts`.
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

## Build output

- Build command: `bun run bundle`
- Binary output: `bin/xeno.js` (via `bun build --outdir ./bin --entry-naming xeno.js`)

## GitHub workflows

- CI workflow: `.github/workflows/ci.yml`
  - Trigger: `pull_request` and `push` to `main`
  - Steps: install (`bun install --frozen-lockfile`), format check (`bunx prettier --check .`), type check (`bun run check`)
- Release workflow: `.github/workflows/release.yml`
  - Trigger: pushed tags matching `v*`
  - Steps: build (`bun run bundle`), package `bin/` into `dist/xeno-<tag>.tar.gz`, generate `dist/xeno-<tag>.tar.gz.sha256`, upload both assets to the tag's GitHub Release
