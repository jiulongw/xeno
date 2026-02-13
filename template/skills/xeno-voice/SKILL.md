---
name: xeno-voice
description: Text-to-speech and speech-to-text using the xeno-voice script. Use when the user asks to synthesize speech from text (TTS), read text aloud, generate audio from a message, narrate something, transcribe audio/video to text, or convert speech to text. Also use for storytelling, voice messages, or when sending audio content.
---

# Voice

Convert text to speech or transcribe audio/video to text using the bundled `scripts/xeno-voice` script.

## Prerequisites

- Optional: `elevenlabs_api_key` in `~/.config/xeno/config.json` (used for ElevenLabs APIs)
- Script runs directly with Bun (`scripts/xeno-voice ...`)
- Without `elevenlabs_api_key`, `say` falls back to macOS `say` and `asr` falls back to macOS dictation
- Fallbacks are macOS-only
- macOS fallbacks support English only

## Text-to-Speech (TTS)

```bash
scripts/xeno-voice say "Hello, world!" -o /tmp/hello.mp3
```

Options:

- `-v, --voice-id ID` — ElevenLabs voice ID (default: `tOuLUAIdXShmWH7PEUrU`)
- `-o, --out-file PATH` — Output audio file path (required)
- `--model-id ID` — TTS model (default: `eleven_multilingual_v2`)
- `--output-format FMT` — Output format (default: `mp3_44100_128`)

Fallback behavior when `elevenlabs_api_key` is missing:

- Uses macOS `say`
- If `-v/--voice-id` is set to a non-default value, it is passed through to `say -v <voice>`
- If `-v/--voice-id` is left at the ElevenLabs default ID, no `say -v` is passed

The message is a positional argument — quote it if it contains spaces or special characters.

## Speech-to-Text (ASR)

```bash
scripts/xeno-voice asr -f /path/to/audio.mp3
```

Prints the transcript to stdout. Supports audio and video files.

Options:

- `-f, --file PATH` — Input audio/video file (required)
- `--model-id ID` — ASR model (default: `scribe_v2`)

Fallback behavior when `elevenlabs_api_key` is missing:

- Uses macOS Speech framework via `swift` (dictation-style recognition)
- Requires Speech Recognition permission for the terminal app
- Timeout is controlled by `XENO_VOICE_MACOS_ASR_TIMEOUT_SECONDS` (default: `30`)

## Voice Selection

The default voice (`tOuLUAIdXShmWH7PEUrU`) is female. If the agent character is male, use `MI36FIkp9wRP7cpWKPTl` instead. Keep preferred voice IDs in `TOOLS.md` for quick reference. Browse voices at the ElevenLabs voice library if the user wants a different style.

## Usage Tips

- For storytelling or narration, generate TTS and send the audio file to the user.
- For transcription of received voice messages or audio attachments, save the file locally first, then run `asr`.
- Output files are created with parent directories automatically.
