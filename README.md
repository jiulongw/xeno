# xeno

Bun CLI app with two commands:

- `serve`: start a long-running placeholder service
- `console`: start an interactive echo console

Both commands require `--home <string>`.

## Install

```bash
bun install
```

## Build

```bash
bun run bundle
```

## Run from source

```bash
bun run src/index.ts serve --home /tmp/xeno
bun run src/index.ts console --home /tmp/xeno
```
