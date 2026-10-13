# ADR 0018: Instagram's licensed audio on posted Reels

Status: accepted (2026-10-13)

## Context

Reels with a recognisable sound do better on Instagram, and studios ask for
"the music Instagram has" rather than the royalty-free tracks ReelWalk can
put into an export. ReelWalk cannot licence that music itself. Mixing a
chart song into the MP4 would also get the Reel muted or taken down.

Instagram's Graph API now has an Audio API. `GET /ig_audio` searches
Instagram's own library. A Reel container created with
`audio_configuration` has the chosen sound mixed in by Instagram when it
publishes, under Instagram's own licence. We tested it on 2026-10-13 against
the production @reelwalking business account, Graph API v25.0, with a
Facebook Login token:

- `GET /ig_audio?audio_type=music|original_sound&user_id=<ig-user-id>&search_query=<optional>`
  returns up to 25 items under the key `audio` (not `data`, unlike most Graph
  lists), with no paging. An empty `search_query` returns what is trending.
- Each item has `audio_id`, `title`, `display_artist` (music) or
  `ig_username` (original sound), `duration_in_ms`,
  `cover_artwork_thumbnail_uri`, and `download_url`. The `download_url` is a
  temporary preview of the sound alone that expires in about a day and a
  half.
- `audio_configuration` is a JSON string
  `{"audio_id": "...", "audio_volume": 0-100, "video_volume": 0-100}` sent
  with `POST /{ig-user-id}/media` (`media_type=REELS`). It needs Graph API
  v22.0 or later.
- The API cannot preview a Reel with the sound attached.

## Decision

(ADR 0019 adds choosing the sound in the editor, editing to a private copy
of its preview, and playing the export with it.)

**Pick, then attach at publish.** The export screen gets one "Instagram
sound" picker shared by Post now and Schedule. It has two tabs, Music
(`music`) and Trending sounds (`original_sound`), and a search box (empty
means trending). Each result shows cover art, title, artist or handle, and
length, with a play button that previews `download_url` through a single
`<audio>` element, so only one sound plays at a time. The ReelWalk export
itself is never changed. The sound is sent as `audio_configuration` when the
container is created, by `startInstagramPost` for Post now and by the
publisher (ADR 0017) for scheduled posts.

**Mix.** By default the sound replaces the reel's own soundtrack
(`audio_volume` 100, `video_volume` 0). "Keep my reel's own music under it"
leaves the soundtrack underneath at `video_volume` 35.

**Data.** `ScheduledPost` gains nullable `audioId`, `audioTitle`,
`audioArtist`, `audioVolume` and `videoVolume` (migration
`20261013180000_scheduled_post_audio`, additive). The title and artist are
copied so `/scheduled` can name the sound without asking Instagram again.
Each upcoming row has a Sound control to change or remove it while the post
is `SCHEDULED`. Once it is `PUBLISHING` the container may already carry the
sound, so it can no longer change.

**Search.** `searchInstagramAudio` (apps/web/lib/instagram-audio.ts) uses
the workspace's connected account and token. Results are cached in process
memory for ten minutes per workspace, account, type and query, so typing and
tab switches do not hit Instagram each time. Ten minutes is far inside the
preview links' lifetime. Expired tokens and missing permissions come back as
messages telling the studio to reconnect. With `DEV_FAKE_INSTAGRAM` the
search answers from a few canned tracks, so the end-to-end suite runs
offline.

**No silent fallback.** If Instagram refuses to create the container with a
sound attached and the error is permanent, the post fails, and the message
names the sound. It is never retried without the sound: a studio that picked
a song would rather get an email than see the Reel go out silent or with
other music. Transient errors are retried as before.

**Graph API version.** The default `META_GRAPH_VERSION` moves from v21.0 to
v25.0 (`DEFAULT_GRAPH_VERSION` in apps/web/lib/instagram.ts, and
`.env.example`). The Login dialog URL uses the same version. Every endpoint
ReelWalk calls (`/oauth/access_token`, `/me/accounts` with
`instagram_business_account`, `/{ig-user-id}/media`, the container's
`status_code`, `/media_publish`, the media's `permalink`) is unchanged
between those versions. No deployment config pinned the old version, so
deployments pick up v25.0 from the code default.

## Why not the alternatives

- **Mix licensed music into the export.** ReelWalk has no licence for
  Instagram's catalogue, and a fingerprinted song in the file gets the Reel
  muted.
- **Fall back to posting without the sound.** Simpler, but it publishes
  something other than what the studio scheduled, and nobody looks at a Reel
  after it has gone out.
- **Look the sound up again at publish time.** `audio_id` is stable, and the
  title and artist are only for display, so a lookup adds a call that can
  fail and gains nothing.

## Consequences

- Business accounts (as ReelWalk requires for publishing) get Instagram's
  commercially cleared catalogue under Music: production-music artists, no
  chart hits. That is a licensing limit of Instagram's, not a bug. The picker
  says "Instagram's music for business accounts" so nobody goes looking for a
  chart hit.
- Trending sounds (`original_sound`) include creators' remixes of commercial
  songs. Instagram may later mute a Reel using one if the rights holder
  objects. The risk is the same as picking that sound in the Instagram app,
  and the studio chooses it. The default tab is Music.
- A Reel with an attached sound cannot be previewed before it is published.
  Only the sound alone can.
- Preview links in a cached result can be up to ten minutes old. They last
  about a day and a half, so they still play.
- The search cache is per process, so App Runner instances each keep their
  own. A miss costs one Graph call.
- The scheduler's `createContainer` dependency now takes `audio`. The claim
  and state machine are unchanged.
