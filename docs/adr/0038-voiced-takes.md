# 0038 - Voiced AI takes with one fixed voice

## Context

The app generates silent Veo takes. Maya's villa reel needed two spoken
lines, made outside the app with Veo's own audio; the two takes came back
as two different women, and the one-voice guard (ADR 0035 follow-up) had
to mute one. A presenter who speaks across shots needs a voice that is the
same every time, with an Australian accent, and mouth movement that
matches.

Options weighed: Veo audio alone (no voice identity), text-to-speech plus a
lip-sync pass on the silent take, ElevenLabs plus lip sync, avatar
platforms. The owner chose text-to-speech plus lip sync, with the voice on
Cloudflare Workers AI.

## Decision

A shot may carry `line` (what she says, up to 200 characters) and `voice`:

- `lipsync`: Veo renders the take silent with her mouth moving; the worker
  speaks the line with the workspace's configured voice on Workers AI
  (`PRESENTER_VOICE`, `melotts:<lang>` or `aura-1:<speaker>`), stores the
  silent take and the audio beside the generation, and sends both to
  sync.so (`lipsync-2`, `bounce` so the take keeps its length). The
  generation stays `RUNNING` with `operationName = lipsync:<id>` and is
  polled like a Veo operation. The finished take replaces the silent one.
  If lip sync fails, the silent take is kept and the generation records
  that the voice could not be added, rather than losing a paid take.
- `veo`: Veo generates the audio itself, with the line and the accent in
  the prompt. For shouted action lines where lip sync will not hold.

A voiced take costs one credit more than a silent one of the same length
and reserves 5 cents per second more of the provider budget. Voiced takes
are transcribed when they land, so captions and ducking work on them like
any upload. Opus proposes `line` and `voice` from the director sheet and is
told the voice is fixed per workspace.

The voice runs as our own Cloudflare Worker (`infra/cloudflare/voice`,
`reelwalk-voice`) with the Workers AI binding and a shared key, so no
Cloudflare API token is needed and the render worker only knows a URL
(`VOICE_TTS_URL`) and the key (`VOICE_TTS_KEY`, Parameter Store).
`SYNC_API_KEY` is the second secret; `VOICE_ENABLED` gates the feature.
Without the sync.so key only the `veo` mode works and a `lipsync` request
refunds.

## Consequences

- One more vendor (sync.so). Workers AI has no lip-sync model, so a
  Cloudflare-only pipeline was not possible.
- The accent depends on the chosen Workers AI voice. Tested 2026-10-19:
  MeloTTS answers for `en` but rejects `en-au` on Workers AI, and Aura-1
  speakers are American English; so the presenter voice is a fixed
  English voice without the Australian accent until a cloned voice
  (ElevenLabs or similar) is added behind the same Worker.
- Lip sync is weakest on wide, fast-moving shots; the director prompt
  steers `lipsync` to settled, face-visible shots and `veo` to action.
