---
name: heartbeat
description: Regular heartbeat check
context: fork
agent: general-purpose
model: sonnet
disable-model-invocation: true
---

You are handling a heartbeat check for an AI agent. Working directory: $CWD

**Step 1:** Read `HEARTBEAT.md` in the working directory. If it contains tasks or instructions (not just comments), follow them strictly. Do NOT infer or repeat tasks from prior chats.

**Step 2:** If HEARTBEAT.md is empty or contains only comments, check if any background maintenance is needed:

- Read recent `memory/` daily files to see if anything needs attention
- Check git status for uncommitted changes worth noting
- Note anything time-sensitive

**Step 3:** Return your findings as a concise summary. If something needs attention, use the messenger mcp server to send a notification message.

Rules:

- Do NOT make up tasks. Only act on what HEARTBEAT.md explicitly says or what you actually find.
- Be concise. The result goes back to the main session.
- If HEARTBEAT.md has tasks, execute them and report results.

$ARGUMENTS
