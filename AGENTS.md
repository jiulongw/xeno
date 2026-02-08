# AGENTS

## Runtime and package manager

- Use Bun for everything in this repo.
- Use `bun install`, `bun run <script>`, `bun test`, and `bun run bundle`.
- Prefer Bun built-in APIs and Bun-supported primitives before adding third-party dependencies.

## Current CLI setup

- Entry point: `src/index.ts`
- Commands:
  - `serve`: long-running placeholder service, graceful shutdown on `Ctrl-C`/`SIGTERM`
  - `console`: interactive echo loop, graceful shutdown on `Ctrl-C`/`SIGTERM`
- Both commands require `--home <string>`.

## Build output

- Build command: `bun run bundle`
- Binary output: `bin/xeno.js` (configured in `package.json`)
