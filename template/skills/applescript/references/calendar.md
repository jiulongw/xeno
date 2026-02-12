# Apple Calendar — AppleScript Reference

## Access Status: ✅ Confirmed

## List All Calendars

```applescript
osascript -e 'tell application "Calendar" to get name of every calendar'
```

## Get Today's Events

```applescript
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

## Get Events for Next N Days

Replace `7` with desired number of days:

```applescript
osascript -e '
tell application "Calendar"
    set today to current date
    set endDate to today + (7 * days)
    set results to {}
    repeat with cal in calendars
        set evts to (every event of cal whose start date ≥ today and start date < endDate)
        repeat with evt in evts
            set end of results to (name of cal) & " | " & (summary of evt) & " | " & (start date of evt as string) & " - " & (end date of evt as string)
        end repeat
    end repeat
    return results
end tell'
```

## Get Event Details

```applescript
osascript -e '
tell application "Calendar"
    set evt to first event of calendar "CalendarName" whose summary is "EventName"
    return {summary of evt, start date of evt, end date of evt, location of evt, description of evt}
end tell'
```

## Create an Event

```applescript
osascript -e '
tell application "Calendar"
    set startDate to date "February 10, 2026 2:00 PM"
    set endDate to date "February 10, 2026 3:00 PM"
    make new event at end of events of calendar "Home" with properties {summary:"Meeting", start date:startDate, end date:endDate, location:"Office"}
end tell'
```

## Delete an Event

```applescript
osascript -e '
tell application "Calendar"
    delete (first event of calendar "CalendarName" whose summary is "EventName")
end tell'
```

## Notes

- Calendar app must be running (or will be launched by osascript).
- After a reboot, a GUI login is required before AppleScript can access Calendar.
- Creating/deleting events changes the user's calendar — always confirm before modifying.
- Events from subscribed calendars (Birthdays, US Holidays, Siri Suggestions) are read-only.
