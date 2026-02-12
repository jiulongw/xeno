---
name: applescript
description: Control Apple apps (Notes, Reminders, Calendar, Mail) via AppleScript using osascript. Use this skill when the user asks to read, create, edit, or manage their Apple Notes, Reminders, Calendar events, or Mail. Also use when checking calendar for upcoming events, reading unread emails, creating reminders, or searching notes. Covers both read and write operations for all four apps.
---

# Apple Scripts

Interact with Apple apps via `osascript` commands. Supports Notes, Reminders, Calendar, and Mail.

## Prerequisites

- macOS with a GUI login session active (AppleScript cannot access apps before GUI login after a reboot).
- Automation permissions granted for each app (prompted on first use per app).

## Supported Apps

| App       | Read | Write | Reference                                          |
| --------- | ---- | ----- | -------------------------------------------------- |
| Notes     | ✅   | ✅    | [references/notes.md](references/notes.md)         |
| Reminders | ✅   | ✅    | [references/reminders.md](references/reminders.md) |
| Calendar  | ✅   | ✅    | [references/calendar.md](references/calendar.md)   |
| Mail      | ✅   | ✅    | [references/mail.md](references/mail.md)           |

Before performing an operation, load the relevant reference file for exact AppleScript syntax.

## Quick Start Examples

**List note folders:**

```bash
osascript -e 'tell application "Notes" to get name of every folder'
```

**Get today's calendar events:**

```bash
osascript -e '
tell application "Calendar"
    set today to current date
    set hours of today to 0
    set minutes of today to 0
    set seconds of today to 0
    set tomorrow to today + (1 * days)
    set results to {}
    repeat with cal in calendars
        set evts to (every event of cal whose start date ≥ today and start date < tomorrow)
        repeat with evt in evts
            set end of results to (name of cal) & " | " & (summary of evt) & " | " & (start date of evt as string)
        end repeat
    end repeat
    return results
end tell'
```

**Get incomplete reminders:**

```bash
osascript -e 'tell application "Reminders" to get name of every reminder in list "Reminders" whose completed is false'
```

**Get unread emails:**

```bash
osascript -e '
tell application "Mail"
    set msgs to (messages of inbox whose read status is false)
    set results to {}
    repeat with m in msgs
        if (count of results) ≥ 10 then exit repeat
        set end of results to (sender of m) & " | " & (subject of m) & " | " & (date received of m as string)
    end repeat
    return results
end tell'
```

## Safety Rules

- **Read operations** — safe to perform anytime without confirmation.
- **Creating notes/reminders/events** — safe to do when user requests it.
- **Deleting or modifying existing data** — confirm with user first.
- **Sending email** — **always** confirm with user before sending. This is an external action.

## Troubleshooting

- **"execution error: An error of type -10810"** — App is not running. It usually auto-launches, but after a reboot before GUI login this will fail. Wait for user to log in.
- **"Not authorized to send Apple events"** — Permission not yet granted. A macOS dialog should appear for the user to approve.
- **Timeout on first use** — Likely a permission dialog waiting for user interaction. Let them know.
