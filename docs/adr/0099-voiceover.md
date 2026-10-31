# 0099 — Voiceover and a voice picker

Date: 2026-10-31

## Context

ADR 0098's Create page makes reels from an idea, but they are silent apart from music. The owner wants a voiceover in a
chosen voice, with captions on the spoken words, both on Create and when changing a reel.

What existed:
- A voice Worker (infra/cloudflare/voice) speaks a line with Workers AI. It is used only for lip-synced presenter takes
  (ADR 0038), in one voice per deployment (`PRESENTER_VOICE`).
- `Presenter.voice` is stored but nothing reads it.
- The worker transcribes speech with word timings (Whisper, ADR 0035). The web container has no speech model.
- Music dips under speech (`speechWindows`), but only under clips' own speech.
- The timeline had no voiceover.

## Decision

**A voiceover on the timeline.**
- `timeline.voiceover = { assetId, atMs, volume, script, voice }`, optional and absent on every saved reel.
- Its asset is a referenced asset, so exports, ownership checks and render plans carry it with its transcript.
- The renderer plays it once from `atMs`.
- `speechWindows` adds its words, so the music and the sounds dip under it. The audio trace and retention checks see it
  as speech too.

**Voices.**
- `VOICES` is ten Deepgram Aura-2 voices on Workers AI (`@cf/deepgram/aura-2-en`), Australian first: Theia (default)
  and Hyperion. Then American and British voices, each with a one-line description from Deepgram's voice list.
- A voiceover names its voice. A voice not on the list is refused.

**The "voiceover" worker step.** A worker-only durable step (`startWorkerStepRun`, as Walk the block, ADR 0093):
1. Speak the script (at most 400 characters, the voice Worker's limit) in the chosen voice.
2. Transcribe it with word timings.
3. Store the MP3 at `workspaces/<ws>/voiceover/<stepId>.mp3`.
4. Keep it as an AUDIO asset (credit "AI voice …"), upserted by object key so a retried attempt writes the same row.

The request id is fixed per reel, script and voice, so asking again for the same line reuses the step.

**`setVoiceover` command.**
- Sets the voiceover and replaces its captions: texts with ids `vo-*`. These are short phrases from its words, each word
  coming into focus as it is said (ADR 0092), white unboxed serif at y 0.62.
- `captions: false` leaves the captions off. `voiceover: null` removes the voiceover and its captions.
- It counts as a change, so it is saved even without captions.

**`add_voiceover` connector tool.** Starts the step and waits for it (up to 4 minutes, for a worker's cold start), then
saves `setVoiceover` as one revision.
- When the voiceover would outrun the reel, a `retimeToLength` goes in the same batch first.
- Shots stretch to 5 s at most. Whatever is still short is answered as `shortByMs`, so the agent can add footage or
  shorten the script.
- Create runs and notes may both use it. A note can now say "add a voiceover saying …" or "use a male voice"; "remove
  the voiceover" is `setVoiceover{voiceover:null}`.

**Create.** The page has a voice picker ("No voiceover", or one of the voices; Theia by default). It is shown only
where `VOICE_ENABLED` is true. The brief tells the run to write a two-to-four sentence script and add it after the cut,
keeping titles few because the captions carry the words.

**A fix to ADR 0098's create runs.** `add_media` onto the reel saves a revision, but the run only recorded
`apply_commands` saves. A run whose last save was an `add_media` would have exported a stale revision and been refused
as a conflict. Saves by `add_media` and `add_voiceover` are now recorded like `apply_commands` saves: revision, lines,
and the note's record.

**A fix to the voice Worker.** It called `@cf/deepgram/aura-2`. The Workers AI model is `@cf/deepgram/aura-2-en`;
`aura-1` is unchanged.

## Consequences

- **To turn it on:**
  1. Redeploy the voice Worker (`wrangler deploy` in infra/cloudflare/voice) for the model fix.
  2. Set `voice_enabled = true` in Terraform and apply. The worker and the web app both read `VOICE_ENABLED`; the
     worker also needs `VOICE_TTS_URL` and `VOICE_TTS_KEY`, which are already wired.
  3. Deploy with `ALLOW_WORKER_ENV_CHANGE=1` if the worker's environment changes.
- **Cost:** Workers AI text to speech per line (cents), plus a worker run to transcribe it. No AI video credits are
  spent, and the month's AI request allowance is not touched: the create run or note that calls the tool is already
  counted.
- **Captions follow the transcript, not the script.** A word Whisper mishears is captioned as heard. The script is kept
  on the timeline for a later check.
- **Library listings.** A voiceover's asset is an AUDIO asset in the library, so it can also be chosen as music.
  Filtering it out of the music picker is left for later.
- **No editor control yet.** A voiceover is added from Create or by a note on the export screen; the editor plays it but
  has no sheet for it.

## Verified

- Core (`tests/voiceover.test.ts`): the schema round trip, the referenced asset, words in reel time, music dipping under
  them, and the captions (focus, per-word timings, y ≤ 0.72). Also: replace, captions off, take off, refused when
  invalid, saved as a change.
- Render: the smoke reel rendered with a voiceover (a 3 s tone from 2 s). Measured mean volume: −91 dB before and
  after, −24.5 dB inside.
- Worker (`tests/voiceover.test.ts`): spoken in the chosen voice, stored under the step and kept as an AUDIO asset by
  object key; kept without captions when nothing is recognised; refusals for a voice not offered, a long script and a
  server without the voice service.
- Web:
  - `lib/voiceover.test.ts`: waiting on the step, one revision with captions, lengthening and `shortByMs`, failures and
    refusals.
  - `lib/create-reels.test.ts`: the voice in the brief only where the server can speak; saves by `add_media` and
    `add_voiceover` moving the exported revision.
  - `lib/voiceover.db.test.ts` (real Postgres): the step queued through the outbox, the saved reel, and the same line
    reusing the step.
- In a browser against the dev server: the picker, defaulting to Theia, with the ten voices.
- Not run here:
  - The real voice Worker (no Cloudflare access from this environment).
  - Whisper on a spoken MP3 (the model is baked only into the worker image).
