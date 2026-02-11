---
name: run-cron-task
description: Run an ad-hoc cron task in an isolated subagent. Use when the agent needs to execute a one-off task prompt via the cron engine without scheduling it persistently. The task prompt is provided as the skill argument.
context: fork
agent: general-purpose
model: sonnet
disable-model-invocation: true
---

You are executing an ad-hoc cron task in an isolated subagent. Working directory: $CWD

**Your task prompt:**

$ARGUMENTS

**Rules:**

- Execute the task prompt above directly and completely.
- Be concise. The result goes back to the main session.
- If the task requires sending a notification, use the messenger MCP server.
- Do NOT perform unrelated work or infer tasks beyond what is explicitly stated.
