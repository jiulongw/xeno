# Gateway Unix Socket JSON-RPC API

This document specifies the Unix domain socket JSON-RPC endpoint exposed by `xeno serve` so external programs can interact with the running agent.

## Endpoint

- Socket path: `<home>/.xeno/gateway.sock`
- Transport: Unix domain socket (`AF_UNIX`, stream)
- Message framing: newline-delimited JSON (one JSON-RPC message per line)
- JSON-RPC version: `2.0`

`<home>` is the resolved xeno home used by `serve` (`--home` or `default_home` from `~/.config/xeno/config.json`).

## JSON-RPC Envelope

Requests:

```json
{ "jsonrpc": "2.0", "id": 1, "method": "gateway.initialize", "params": {} }
```

Responses:

```json
{ "jsonrpc": "2.0", "id": 1, "result": { "sessionId": null, "history": [] } }
```

```json
{ "jsonrpc": "2.0", "id": 1, "error": { "code": -32000, "message": "Invalid query params." } }
```

Notifications (server -> client):

```json
{
  "jsonrpc": "2.0",
  "method": "gateway.stream",
  "params": { "requestId": "...", "content": "...", "isPartial": false }
}
```

## Types

```ts
type PlatformContext = {
  type: "rpc";
  userId?: string;
  channelId?: string;
  metadata?: Record<string, unknown>;
};

type AttachmentType = "image" | "video" | "audio" | "voice" | "document" | "animation" | "sticker";

type Attachment = {
  type: AttachmentType;
  path: string;
  mimeType?: string;
  fileName?: string;
  caption?: string;
  size?: number;
};

type ConversationTurn = {
  role: "user" | "assistant";
  content: string;
};
```

## RPC Methods

### `gateway.initialize`

Get current session snapshot.

Request params:

- Optional. Any value is currently ignored.

Response:

```ts
{
  sessionId: string | null;
  history: ConversationTurn[];
}
```

### `gateway.query`

Submit a user message to the gateway.

Request params:

```ts
{
  requestId: string;         // required, non-empty
  content: string;           // required, non-empty after trim
  context: PlatformContext;  // required; type must be "rpc"
  attachments?: Attachment[];
}
```

Synchronous response:

```ts
{
  accepted: true;
}
```

Completion and output are delivered asynchronously via notifications (`gateway.stream`, `gateway.stats`, `gateway.error`, `gateway.done`).

Validation contract:

- `context.type` must be `rpc`
- `attachments` must be an array if provided
- each attachment requires:
  - `type`: valid `AttachmentType`
  - `path`: non-empty string

Notes:

- The RPC server normalizes accepted query context to `type: "rpc"`.
- A client identifier should be sent in `context.metadata.clientName` (example: `"console"`).
- In `xeno serve`, RPC queries include MCP server `xeno-messenger` (tool: `send_message`).
- RPC queries do not include `xeno-reply-attachment`.

### `gateway.abort`

Request abort of the currently active query.

Request params:

```ts
{
  requestId?: string; // accepted but not used for routing
}
```

Response:

```ts
{
  ok: true;
}
```

Behavior:

- Abort is global for the active gateway query (not scoped by `requestId`).
- This is best-effort; the query may already be near completion.

### `gateway.heartbeat`

Trigger the built-in heartbeat task immediately.

Request params:

- `{}` or omitted.

Response:

```ts
{
  ok: boolean;
  message: string;
  result?: string;
  durationMs?: number;
}
```

If unavailable in current runtime, `ok` is `false` with a human-readable `message`.

### `gateway.new_session`

Trigger the weekly new-session task immediately.

Request params:

- `{}` or omitted.

Response:

```ts
{
  ok: boolean;
  message: string;
  result?: string;
  durationMs?: number;
}
```

If unavailable in current runtime, `ok` is `false` with a human-readable `message`.

## Server Notifications

### `gateway.stream`

```ts
{
  requestId: string;
  content: string;
  isPartial: boolean;
  attachments?: Attachment[];
}
```

Notes:

- `requestId` correlates with the `gateway.query` request.
- Current implementation only includes `attachments` on non-partial (`isPartial: false`) messages.

### `gateway.stats`

```ts
{
  requestId: string;
  stats: string;
}
```

### `gateway.error`

```ts
{
  requestId: string;
  error: string;
}
```

Used for query execution errors delivered asynchronously (separate from JSON-RPC request/response errors).

### `gateway.done`

```ts
{
  requestId: string;
}
```

Indicates query stream completion for a request.

## Query Lifecycle Contract

For each `gateway.query`:

1. Client sends request and receives `{ accepted: true }`.
2. Server sends zero or more async notifications tied to `requestId`.
3. Terminal completion is represented by `gateway.done`.

Current runtime constraints:

- The gateway processes one active query at a time globally.
- Treat `gateway.query` as single-flight: send the next query after completion of the previous one.
- `gateway.abort` is global and does not guarantee an immediate terminal event for every in-flight request. Client-side timeout/cancellation handling is recommended.

## Error Contract

JSON-RPC-level errors (request fails before/while dispatching method):

- returned in JSON-RPC `error` response
- implementation currently uses `code: -32000` for method/validation/runtime errors in server handler
- message examples:
  - `Method not found: <method>`
  - `Invalid query params.`
  - `Invalid query context type.`

Async query runtime errors:

- emitted as `gateway.error` notification and typically followed by `gateway.done`

## Minimal Session Example

```json
{"jsonrpc":"2.0","id":1,"method":"gateway.initialize"}
{"jsonrpc":"2.0","id":1,"result":{"sessionId":"abc","history":[{"role":"user","content":"hello"}]}}

{"jsonrpc":"2.0","id":2,"method":"gateway.query","params":{"requestId":"req-1","content":"hello","context":{"type":"rpc","channelId":"default","metadata":{"clientName":"console"}}}}
{"jsonrpc":"2.0","id":2,"result":{"accepted":true}}
{"jsonrpc":"2.0","method":"gateway.stats","params":{"requestId":"req-1","stats":"result=success duration=0.42s"}}
{"jsonrpc":"2.0","method":"gateway.stream","params":{"requestId":"req-1","content":"hello","isPartial":false}}
{"jsonrpc":"2.0","method":"gateway.done","params":{"requestId":"req-1"}}
```
