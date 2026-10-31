# 0100 — A chosen voice for a lip-synced take

Date: 2026-10-31

## Context

A lip-synced presenter take (ADR 0038) speaks its line in one voice for the whole deployment (`PRESENTER_VOICE`,
`melotts:en` by default and in production). A new presenter therefore cannot have a voice of her own, and every
fictional presenter sounds the same. The voiceover (ADR 0099) already lets a reel choose from `VOICES`.

## Decision

- **The shot can name a voice.** `voiceId` is optional on an AI shot and must be one of `VOICES` (the voiceover's Aura-2
  list). It is for `voice: "lipsync"` only, because Veo's own audio has no choice of speaker.
  - The web refuses any other value when the shot is asked for (`aiShotSchema`).
  - Without a `voiceId`, the line is spoken in `PRESENTER_VOICE`, exactly as before.
- **It travels with the take.**
  - It is stored in the generation's shot.
  - A draft keeps it but makes no voice (ADR 0076).
  - "Make it final" copies the draft's shot, so the final speaks in the draft's voice.
  - The worker's `startVoice` passes it to `synthesiseLine`, whose request to the voice Worker names that voice. The key
    handling is unchanged.
- **No audio from another voice is reused.**
  - A take's line audio and its sync.so job are keyed by the take, and a take has one voice.
  - A request id already used answers with its take only when the line and voice match (`aiShotVoiceKey`). Asking for a
    different line or voice under the same id is refused, so it is never handed a take in the other voice.
- **A voice withdrawn while a take waits is refunded before Veo is asked.** This also covers a stored shot that no longer
  reads back. Such a take is never submitted silent.

## Deploying

1. The voice Worker must be on `@cf/deepgram/aura-2-en` first (ADR 0099). Until then every Aura-2 voice fails with 403.
   Deploy it, then run `infra/cloudflare/voice/smoke.sh`.
2. Deploy the web app and the worker image from the reviewed, green commit. Neither order breaks anything: a stored
   `voiceId` is only read by the new worker, and the old worker ignores it. Still, deploy the worker first so no take is
   queued with a voice the running worker would ignore.
3. Then one paid lip-sync smoke test with a chosen voice. It needs the owner's approval of the spend.

## Verified

- Core (`tests/ai-shots.test.ts`):
  - two different offered voices are kept;
  - a voice not offered, `melotts:en`, a voice with Veo audio and a voice without a line are refused;
  - absent means unset, and older stored takes read back unchanged;
  - a draft's voice reads back on its final;
  - the voice key tells lines and voices apart, and ignores the seed and tier.
- Worker (`tests/ai-video.test.ts`, `tests/voice.test.ts`):
  - Theia and Hyperion reach `synthesiseLine` as different speakers, and no `voiceId` gives `PRESENTER_VOICE`;
  - a draft makes no voice, and its final speaks in the draft's voice;
  - a voice not offered is refunded before submission;
  - the request body sent to the voice Worker names the chosen voice, with the key in its header as before.
- Database (`tests/ai-credits.test.ts`, real Postgres): a retry with the same request id returns the same take. The same
  id with another voice, no voice or another line is refused, and nothing more is made.
