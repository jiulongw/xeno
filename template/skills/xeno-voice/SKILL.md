---
name: xeno-voice
description: Text-to-speech and speech-to-text using ElevenLabs API via the xeno-voice script. Use when the user asks to synthesize speech from text (TTS), read text aloud, generate audio from a message, narrate something, transcribe audio/video to text, or convert speech to text. Also use for storytelling, voice messages, or when sending audio content. Requires elevenlabs_api_key in ~/.config/xeno/config.json.
---

# Voice (ElevenLabs)

Convert text to speech or transcribe audio/video to text using the bundled `scripts/xeno-voice` script.

## Prerequisites

- `elevenlabs_api_key` must be set in `~/.config/xeno/config.json`
- Script runs via `uv run --script` (auto-installs dependencies)

## Text-to-Speech (TTS)

```bash
scripts/xeno-voice say "Hello, world!" -o /tmp/hello.mp3
```

Options:

- `-v, --voice-id ID` — ElevenLabs voice ID (default: `tOuLUAIdXShmWH7PEUrU`)
- `-o, --out-file PATH` — Output audio file path (required)
- `--model-id ID` — TTS model (default: `eleven_multilingual_v2`)
- `--output-format FMT` — Output format (default: `mp3_44100_128`)

The message is a positional argument — quote it if it contains spaces or special characters.

## Speech-to-Text (SAR)

```bash
scripts/xeno-voice sar -f /path/to/audio.mp3
```

Prints the transcript to stdout. Supports audio and video files.

Options:

- `-f, --file PATH` — Input audio/video file (required)
- `--model-id ID` — SAR model (default: `scribe_v2`)

## Voice Selection

The default voice (`tOuLUAIdXShmWH7PEUrU`) is female. If the agent character is male, use `MI36FIkp9wRP7cpWKPTl` instead. Keep preferred voice IDs in `TOOLS.md` for quick reference. Browse voices at the ElevenLabs voice library if the user wants a different style.

## Usage Tips

- For storytelling or narration, generate TTS and send the audio file to the user.
- For transcription of received voice messages or audio attachments, save the file locally first, then run `sar`.
- Output files are created with parent directories automatically.
