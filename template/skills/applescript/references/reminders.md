# Apple Reminders — AppleScript Reference

## Access Status: ✅ Confirmed

## List All Reminder Lists

```applescript
osascript -e 'tell application "Reminders" to get name of every list'
```

## List Reminders in a List

Incomplete reminders only:

```applescript
osascript -e '
tell application "Reminders"
    get name of every reminder in list "ListName" whose completed is false
end tell'
```

All reminders (including completed):

```applescript
osascript -e '
tell application "Reminders"
    get name of every reminder in list "ListName"
end tell'
```

## Get Reminder Details

```applescript
osascript -e '
tell application "Reminders"
    set r to first reminder in list "ListName" whose name is "ReminderName"
    return {name of r, due date of r, completed of r, body of r}
end tell'
```

## Create a Reminder

Basic:

```applescript
osascript -e '
tell application "Reminders"
    make new reminder in list "ListName" with properties {name:"Reminder text"}
end tell'
```

With due date:

```applescript
osascript -e '
tell application "Reminders"
    set dueDate to date "February 10, 2026 9:00 AM"
    make new reminder in list "ListName" with properties {name:"Reminder text", due date:dueDate}
end tell'
```

## Complete a Reminder

```applescript
osascript -e '
tell application "Reminders"
    set completed of (first reminder in list "ListName" whose name is "ReminderName") to true
end tell'
```

## Delete a Reminder

```applescript
osascript -e '
tell application "Reminders"
    delete (first reminder in list "ListName" whose name is "ReminderName")
end tell'
```

## Notes

- Reminders app must be running (or will be launched by osascript).
- After a reboot, a GUI login is required before AppleScript can access Reminders.
- Creating/completing/deleting reminders changes the user's data — confirm before destructive operations.
