# ADR 0019: Editing a reel to an Instagram sound

Status: accepted (2026-10-13)

## Context

ADR 0018 lets a studio attach a sound from Instagram's library when it posts.
The sound is picked on the export screen, after the reel is cut, so the cuts
know nothing about it: a reel cut to one song's beat goes out with another
song. Studios want to pick the sound first and edit to it, as in the
Instagram app, with the editor's beat snapping.

What the Graph API gives (v25.0, tested on the @reelwalking business account):

- `GET /{audio-id}?user_id=<ig-user-id>` returns one sound with a fresh
  `download_url`: a temporary preview on Instagram's CDN (fbcdn), MP4/M4A,
  that lasts about a day and a half. The CDN sends no CORS headers, so a
  page can play it in an `<audio>` element but cannot read its bytes.
- `audio_configuration` (`audio_id`, `audio_volume`, `video_volume`) has no
  start offset. An attached sound always plays from its beginning.
- A reel with an attached sound cannot be previewed before it is posted.
- Business accounts get Instagram's commercially cleared music and creators'
  original sounds, not the chart catalogue.

## Decision

**A private copy for editing.** Choosing an Instagram sound in the editor's
Music sheet (tabs "Instagram music" and "Trending sounds" next to "Your
songs", search and pasted audio links as in ADR 0018) asks the server for it.
The server fetches a fresh `download_url` by id, downloads the preview (at
most 25 MB, 60 s) and stores it in the workspace's storage as an `AUDIO`
`MediaAsset` under `uploads/<workspace>/instagram-audio/<audio-id>.<ext>`,
flagged with `instagramAudioId`, `instagramTitle` and `instagramArtist`
(migration `20261013210000_instagram_audio_assets`, additive: nullable
columns and a unique index on `(workspaceId, instagramAudioId)`, which every
existing row satisfies). Choosing the same sound again reuses the row. From
then on it is an ordinary song to the editor: the Remotion preview plays it
from a presigned storage URL, and the browser fetches that URL (storage
answers CORS) to measure its length and find its tempo with the same
detector as uploads, so "Snap cuts to the beat" works. The browser never
fetches fbcdn.

The copy is counted against the workspace's storage, is deleted with the
workspace, and is never shown under "Your songs", picked by auto-build or
venue reels, or listed as a song on the home screen.

**Never in an export.** The timeline's music records `instagramAudioId`, and
the export payload marks the copy's asset `instagramAudio: true` from the
database row, not from the browser. `reelRenderPlan` in `@reelwalk/core`
removes the music and the file from what the worker hands Remotion when
either says it is Instagram's, so the MP4 carries only the clips' own audio.
`renderReel` drops Instagram music again as a last check. The sound reaches
the post only as `audio_configuration`, under Instagram's licence (ADR 0018).

**From the start.** Because Instagram has no start offset, a timeline whose
music is an Instagram sound always has `sourceStartMs` 0 (the music schema
forces it, so an old or edited timeline cannot say otherwise), and the Music
sheet hides "Start the song at" with the line "Instagram plays this sound
from its start". The volume slider stays, labelled as the preview's volume:
Instagram sets its own mix.

**Posting.** The export screen reads the reel's sound from the export's
payload and the asset row, and starts its Instagram sound picker on it
(`audio_volume` 100, `video_volume` 0). The studio can still change or remove
it, and "keep my reel's own music" still works. Post now and Schedule send
whatever is chosen, as in ADR 0018.

**Play with sound.** Instagram cannot preview the result, so the export
screen can: "Play with sound" plays the rendered video with the chosen
sound's preview, both from 0. The video drives: play, pause, seek and loop
are followed, and every 250 ms the sound is pulled back if it has drifted
more than 80 ms. Past the end of a shorter sound the reel plays on silent.
With "keep my reel's own music" the video's sound plays underneath at 35 %,
as Instagram will mix it. The sound comes from the same private copy (made
on first play for a sound picked only on the export screen), never from
fbcdn.

**Offline.** With `DEV_FAKE_INSTAGRAM` the canned sounds all download as one
generated WAV (12 s of clicks at 120 bpm, `fakeInstagramSoundWav`), also
served at `/api/dev/instagram/sound` for the picker's play buttons, so the
end-to-end suite can choose a sound, snap to its beat, export and play it
with the reel without Instagram.

## Why not the alternatives

- **Play fbcdn in the browser directly.** Playback works without CORS, but
  tempo detection needs the bytes, and the links expire in a day and a half,
  so a reel reopened next week would have no music.
- **Proxy fbcdn on every request.** No copy to manage, but every preview
  load needs a fresh link from the Graph API, and an `<audio>` element that
  cannot seek in a streamed response cannot be kept in sync.
- **Detect the tempo on the server.** The web server has no audio decoder
  (no ffmpeg on App Runner); the browser already has one and the detector.
- **Let the studio choose where the sound starts.** Instagram would ignore
  it, and the post would not match the edit.

## Consequences

- Copies are for editing only. They are never rendered, never published and
  never offered for download, but they are copies of Instagram's previews
  kept for as long as the workspace keeps them. Disconnecting Instagram does
  not delete them yet; a reel already edited to one keeps playing in the
  editor. If Meta's terms require it, deleting them on disconnect is a small
  follow-up (the rows are marked).
- Whether `download_url` is the whole sound or a clip is not documented.
  The editor measures the decoded length and the server logs
  `instagram sound: preview X s of a Y s sound` against `duration_in_ms`, so
  production logs answer it. If previews are clips, cuts past the clip's end
  still snap to the beat grid (it is regular), but the editor preview and
  Play with sound are silent there while Instagram's post will not be. An
  Instagram sound does not loop in the editor preview (your own songs do),
  since Instagram plays it once from its start.
- Business accounts still only get the cleared catalogue and original
  sounds (ADR 0018).
- The downloaded and shared MP4 has no music when the reel was edited to an
  Instagram sound. The export sheet and export screen say so.
