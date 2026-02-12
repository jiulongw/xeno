# Apple Mail — AppleScript Reference

## Access Status: ✅ Confirmed

## List All Accounts

```applescript
osascript -e 'tell application "Mail" to get name of every account'
```

## List Mailboxes

```applescript
osascript -e 'tell application "Mail" to get name of every mailbox'
```

## Get Recent Unread Messages (per account)

**⚠️ IMPORTANT:** Always use `mailbox "INBOX" of account` (or `mailbox "Inbox"` for Exchange). Do NOT use `inbox of account` — it returns 0 results.

```applescript
osascript -e '
tell application "Mail"
    set acct to account "Google"
    set inboxBox to mailbox "INBOX" of acct
    set msgs to (every message of inboxBox whose read status is false)
    set results to {}
    repeat with m in msgs
        if (count of results) ≥ 10 then exit repeat
        set end of results to (sender of m) & " | " & (subject of m) & " | " & (date received of m as string)
    end repeat
    return results
end tell'
```

**Account inbox names vary by provider:**

- iCloud: `mailbox "INBOX" of account "iCloud"`
- Google/Gmail: `mailbox "INBOX" of account "AccountName"`
- Exchange: `mailbox "Inbox" of account "AccountName"` (capital I, lowercase nbox)

List accounts first to discover exact names: `tell application "Mail" to get name of every account`

## Read a Message Body

```applescript
osascript -e '
tell application "Mail"
    set m to first message of inbox whose subject is "Subject Line"
    return content of m
end tell'
```

## Send an Email

**⚠️ CAUTION: This is an external action — always confirm with user before sending.**

```applescript
osascript -e '
tell application "Mail"
    set newMsg to make new outgoing message with properties {subject:"Subject", content:"Body text", visible:true}
    tell newMsg
        make new to recipient at end of to recipients with properties {address:"email@example.com"}
    end tell
    send newMsg
end tell'
```

## Mark as Read

```applescript
osascript -e '
tell application "Mail"
    set read status of (first message of inbox whose subject is "Subject Line") to true
end tell'
```

## Known Limitations

- **Reply with quoted content:** AppleScript's `reply` command opens a reply window with quoted original, but `content` reads as empty and `html content` is access-restricted. Setting `content` on a reply overwrites the quoted text. **Workaround:** Draft reply text in chat for user to paste, rather than creating reply drafts via AppleScript.
- **Flag colors don't sync:** Exchange/Outlook flag index values only apply locally in Apple Mail — they don't sync across devices. Only iCloud flags sync.

## Notes

- Mail app must be running (or will be launched by osascript).
- After a reboot, a GUI login is required before AppleScript can access Mail.
- **Sending email is an external action** — always ask user for confirmation before sending.
- Reading email is fine without confirmation per user permissions.
- Access may require a permission prompt on first use.
