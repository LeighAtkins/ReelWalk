# 0035 — Transcribe every uploaded video, and caption speech on its words

## Decision

When the worker makes a video's preview rendition (every upload goes through
this), it also runs speech recognition on the first three minutes and stores
the words with their timings on `MediaAsset.transcript`. A silent video, or
one without an audio track, stores nothing.

The editing model sees a `says:` line for any clip with speech: the phrases
and when they play, measured from the clip's own start as it is played. A
new edit operation, `captionSpeech`, lays one caption per phrase on those
timings. Running it again on the same clip replaces its captions rather than
stacking them.

## Why

In the villa reel (see `docs/postmortems/2026-10-19-maya-villa-reel.md`)
captions over the presenter's lines were wrong three times in a row. Opus
reviews still frames and cannot hear, so it guessed. When we transcribed the
clips by hand and gave it the word timings, the captions landed first time.
Transcripts also tell the app which clips carry a voice, which the single
presenter voice rule needs.

## How

- **Model:** Whisper small (English) exported with attention outputs, the
  `_timestamped` variant from `onnx-community`, quantised (q8), through
  `@huggingface/transformers` on the CPU. About 240 MB, cached into the
  worker image at build time (`scripts/fetch-whisper.mjs`), never downloaded
  by a render task. An 8-second clip takes about 2 seconds after the first
  load; the first load in a task takes about 2 seconds more.
- **Audio:** `ffmpeg` extracts the first audio stream as 16 kHz mono PCM.
  "No audio stream" is a normal result, not an error.
- **Phrases:** `speechPhrases` breaks at sentence punctuation, before a
  joining word (and, but, or, so, then) once a phrase has two words, at a
  pause over 600 ms, and at five words or three seconds.
- **Timing:** source milliseconds map through the clip's trim and speed.
  A word cut by the trim counts when at least 100 ms of it is heard.
- **Limits:** English only for now (`whisper-small.en`); other languages
  would need the multilingual model. Whisper can invent words over music or
  noise; a transcript is a strong hint, not proof that a clip is voiced.

## Not done yet

Existing media is not transcribed automatically; a backfill script covers
the presenter takes already in use. AI shots generated in the app are silent
and skip transcription. Voiced takes made outside the app are transcribed
when they are registered.
