# Apple Notes — AppleScript Reference

## Access Status: ✅ Confirmed

## List All Folders

```applescript
osascript -e 'tell application "Notes" to get name of every folder'
```

## List Notes in a Folder

```applescript
osascript -e 'tell application "Notes" to get name of every note in folder "FolderName"'
```

## Read a Note's Content

Returns HTML-formatted body:

```applescript
osascript -e 'tell application "Notes" to get body of note "NoteName" in folder "FolderName"'
```

For plain text, pipe through a converter or strip tags:

```applescript
osascript -e 'tell application "Notes" to get plaintext of note "NoteName" in folder "FolderName"'
```

## Create a New Note

Body uses HTML formatting:

```applescript
osascript -e '
tell application "Notes"
    make new note at folder "FolderName" with properties {name:"Title", body:"<div>Content here</div>"}
end tell'
```

## Modify a Note

Append or replace body content:

```applescript
osascript -e '
tell application "Notes"
    set body of note "NoteName" in folder "FolderName" to "<div>New content</div>"
end tell'
```

## Delete a Note

```applescript
osascript -e '
tell application "Notes"
    delete note "NoteName" in folder "FolderName"
end tell'
```

## Search Notes

```applescript
osascript -e '
tell application "Notes"
    set results to {}
    repeat with n in every note
        if name of n contains "search term" then
            set end of results to name of n
        end if
    end repeat
    return results
end tell'
```

## Notes

- Note bodies are HTML. Use `<div>` for paragraphs, `<br>` for line breaks.
- The Notes app must be running (or will be launched automatically by osascript).
- After a reboot, a GUI login is required before AppleScript can access Notes.
- Creating/modifying/deleting notes changes the user's data — always confirm with user before destructive operations.
