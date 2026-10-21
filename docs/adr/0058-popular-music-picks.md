# 0058 - Popular music picks ("Popular now")

Status: accepted (2026-10-21)

## Context

The owner's idea: "An AI agent that only picks good music. How do we know
it's good? If people add it to popular Spotify playlists then it's
popular. Cross that with what's in Instagram's business music library and
we'll find the good stuff."

The Music sheet (ADRs 0018, 0019, 0021) already opens on Instagram's
library: its trending list, one-tap searches and search. What it lacks is
any outside sign of which of those sounds people actually like. Before
building, we checked what the two platforms allow a new app to do today.

### What Spotify allows a new app (checked 2026-10-21)

- **New apps start in Development Mode**: at most 5 allowlisted users, and
  the app owner must keep Spotify Premium for the app to work. Extended
  quota has been for organisations only since 15 May 2025: a registered
  business with at least 250k monthly active users, among other criteria.
  That rules ReelWalk out for now.
  [Quota modes](https://developer.spotify.com/documentation/web-api/concepts/quota-modes),
  [2026-02-06 update](https://developer.spotify.com/blog/2026-02-06-update-on-developer-access-and-platform-security).
- **February 2026 Web API changes** (Development Mode):
  - `GET /playlists/{id}/tracks` is renamed `/items`. It is "only accessible
    for playlists owned by the current user or playlists the user is a
    collaborator of", and returns 403 otherwise. `GET /playlists/{id}`
    returns only metadata for other people's playlists.
  - `popularity` is removed from Track, Album and Artist.
  - Search allows at most 10 results per page (it was 50).
  - `external_ids` (the ISRC) was listed for removal, then kept (March 2026
    changelog).
  - The current Get Playlist schema shows no `followers` field on
    playlists; no changelog entry says it was removed.

  Sources: [February 2026 changelog](https://developer.spotify.com/documentation/web-api/references/changes/february-2026),
  [March 2026 changelog](https://developer.spotify.com/documentation/web-api/references/changes/march-2026),
  [Get Playlist Items](https://developer.spotify.com/documentation/web-api/reference/get-playlists-items).
- **Removed for new apps since 27 November 2024**, with no reversal found:
  Recommendations, Audio Features, Audio Analysis, Related Artists,
  Featured Playlists, Category's Playlists, and Spotify's editorial and
  algorithmic playlists.
  [Blog post](https://developer.spotify.com/blog/2024-11-27-changes-to-the-web-api).
- **Policy and terms** (in force 15 May 2025):
  - [Developer Policy](https://developer.spotify.com/policy) III.13: "Do
    not analyze the Spotify Content or the Spotify Service for any purpose",
    including "creating new or derived listenership metrics".
  - Policy II.5: "metadata and cover art may only be used in connection
    with the underlying content".
  - [Developer Terms](https://developer.spotify.com/terms) IV.3.1.1: do not
    store Spotify Content indefinitely, or "create compilations or
    databases" of it beyond what operating the app needs.
  - Terms IV.2.1: no training of ML or AI models on Spotify Content.
  - Terms IV.2.4.1: no robot, spider or other tool to "retrieve, duplicate,
    or index" Spotify Content.

**Conclusion.** A new Spotify app cannot read the tracks of public
playlists, and probably cannot read their follower counts or track
popularity. Even with that access, scoring tracks by playlist followers
and storing the result is a "derived listenership metric" in a database of
Spotify Content, which the policy forbids. So **ReelWalk does not call
Spotify's API**, and no `SPOTIFY_CLIENT_ID` or `SPOTIFY_CLIENT_SECRET` is
added.

### What Instagram allows (checked 2026-10-21)

- **The Audio API** ([docs](https://developers.facebook.com/documentation/instagram-platform/content-publishing/audio-api))
  is what our code already uses. It needs Facebook Login and a Business or
  Creator account.
  - `GET /ig_audio?audio_type=music|original_sound&user_id=…&search_query=…`
    searches the library. With no query it returns trending sounds.
  - `GET /{audio-id}` returns one sound.
  - `audio_configuration` on the Reels container attaches a sound when
    posting.
  - Fields returned: `audio_id`, `title`, `display_artist` (music),
    `ig_username` (original sounds), `duration_in_ms`, `download_url`,
    `is_ads_eligible`, `on_platform_audio_preview_link`.
  - There is **no ISRC and no popularity field**.
  - Results are audio "authorized for third party use" and "may vary from
    what appears in the native app". For a business account, `music` is
    Meta's royalty-free Sound Collection.
- **What we already learned by hand** (`.tools/ig-sounds.ts`, 2026-10-15):
  chart songs searched by name come back as soundalike stock. Recognisable
  melodies are reachable as creators' `original_sound` covers, for example
  piano covers of Nuvole Bianche or Sunset Lover, and those have published
  fine from @reelwalking.
- **No API exposes the in-app picker's full catalogue**, nor any export of
  it. The only catalogue we can reach is what `/ig_audio` search returns for
  the connected account.

So the business library holds few, if any, of the songs that popular
playlists carry. Matching only exact recordings would almost always come
back empty. Matching **covers** of popular songs as well is what makes the
owner's idea work on Instagram.

## Decision

**The popularity data is a snapshot, not a Spotify call.** The worker job
reads a playlist snapshot: JSON in `playlistSnapshotSchema`
(`packages/core/src/music-picks.ts`). For each playlist it lists the id,
name, follower count, the moods whose search found it, and the tracks in
order (title, artist, optional ISRC, optional 0-100 popularity). The
snapshot can come from a chart-data provider whose licence allows this use,
or be curated by hand from public listings. It must not be produced by
scraping Spotify or by calling Spotify's API (Spotify Terms IV.2.4.1 and
the clauses above). Choosing and licensing a provider is the owner's
decision; this change does not evaluate any.

**Moods.** There are six moods, each with the seed search the owner named:

| Mood id | Seed search |
| --- | --- |
| `luxury-home-tour` | "luxury home tour" |
| `summer-house` | "summer house" |
| `cozy-winter` | "cozy winter" |
| `upbeat-real-estate` | "upbeat real estate" |
| `chill-piano` | "chill piano" |
| `deep-house` | "deep house" |

`reelMoods` reads a reel's mood from its words: the title (each match
counts double), clip rooms, words on screen and the hook, plus its looks
(each counts half, and is never enough alone). Words match whole words
only. It returns at most two moods and falls back to `luxury-home-tour`.

**Scoring** (`scorePlaylistSnapshot`):

```
score = Σ over playlists [ ln(1 + followers) × 1/log2(position + 1) ]
        + (popularity / 100) × 5          (when the source has it)
```

- The position weight is 1 at the top, 0.63 at 2nd, 0.5 at 3rd and 0.25 at
  15th.
- A playlist found by two mood searches counts once, with the moods merged.
- A track listed twice in one playlist counts at its best position.
- **Dedupe:** by ISRC, otherwise by normalised title plus first artist.
  Normalising removes accents, "feat.", "- Remastered", "(Radio Edit)" and
  similar, but a remix stays a separate song. The two keys are linked, so a
  copy with an ISRC and one without merge.

**Matching** (`matchInstagramSound`, deliberately strict):

- **"track"**: an Instagram `music` sound with title similarity ≥ 0.92 and
  first-artist similarity ≥ 0.85 (normalised Levenshtein), or the same
  ISRC.
- **"cover"**: an `original_sound` whose title, once cover words and the
  artist's name are removed, matches the song's title at ≥ 0.95. The title
  must also contain a cover word (piano, cover, version, instrumental, …)
  or name the artist. A one-word song title ("Experience", "Home") also
  requires the artist's name.
- "Original audio" never matches, and sounds under 15 s (snippets) are
  skipped.
- Instagram is searched by title alone, since its search matches titles;
  the matcher checks the artist. Fixtures in the tests pin both the true
  and false positives.

**The job** (`apps/worker/src/music-chart.ts`, run by
`scripts/music-chart.ts`) does the following, in order:

1. Scores the snapshot and keeps the top 1000 songs.
2. Looks up on Instagram the best 12 songs of each mood, at most 60 in
   all, through the given workspace's connected account. It searches
   `music` first and `original_sound` only when no recording matched. The
   calls are 1.5 s apart, about 120 per run, and a failed search is
   skipped.
3. Records each sound's rank in Instagram's trending lists.
4. Copies the tempo of any copy of the sound someone has already analysed.
5. Upserts the songs as `MusicCandidate` rows. Songs it looked up and could
   not match have their old match cleared. Rows not in the snapshot are
   deleted: a snapshot replaces the chart.

`--dry-run` prints the top picks per mood. With `DEV_FAKE_INSTAGRAM=true`
it searches the local pretend library.

**Storage.** `MusicCandidate` is one global table, not per workspace,
added by migration `20261021030000_music_candidates`:

- the song: `key` (unique), `isrc`, `title`, `artist`, `score`, `moods`,
  `playlists`, `source`;
- the match: `igAudioId`, `igAudioType`, `igTitle`, `igArtist`,
  `igDurationMs`, `igMatch`, `igConfidence`;
- signals: `trendingRank`, `bpm`;
- times: `fetchedAt`, `matchedAt`.

The migration is additive only.

**The picks** (`pickPopularSounds`, behind `popularSounds` in
`apps/web/lib/music-picks.ts`):

- For the reel's moods, it ranks matched rows by score plus a trending
  bonus (`4 / log2(rank + 1)`). The second mood is weighted 0.8, and a
  sound shorter than the reel 0.5.
- It returns up to 5, one per Instagram sound.
- Songs of other moods never fill the row. Only when nothing fits the
  reel's moods is the chart's overall best shown.
- Each pick carries the sound as an `InstagramAudioTrack`, the tempo
  (the workspace's own measurement first, then the chart's) and a why line
  built only from stored data. Example: "In 14 playlists like Cozy Winter
  Evenings, 2.1M followers, trending on Instagram". A cover reads "Cover of
  a song in …".

**No model in the loop.** The brief allowed Opus to rank or explain. We
leave it out because the ranking is deterministic and the explanation is
the data. Calling a model would add seconds and AI cost to every tap on
Music and could only reorder rows that already exist. The structural
guard holds either way: the picks can only return stored, matched
`MusicCandidate` rows, so neither code nor a model can invent a track. If a
model re-ranking is wanted later, it must take candidate ids and be
filtered back to them.

**UI.** In the Music sheet, a "Popular now" list sits first under "Powered
by Instagram", above the Music / Trending tabs. Each row shows the title,
the artist, the bpm when known, and the why line. Tapping a row does exactly
what tapping a search result does: it fetches the sound, measures its beat
and snaps the cuts. The list is not shown while loading, when the chart is
empty, or when the workspace cannot use Instagram's sounds. Nothing else in
the sheet changes. The request goes through the stable
`/api/instagram/sounds` route (`action: "popular"`), and the server caches
the chart for a minute.

## Consequences

- With no snapshot loaded, the feature does nothing: the row is hidden and
  the sheet is as before. **The owner must supply snapshots** (see below)
  and rerun the job to refresh them; it is not scheduled yet.
- Most matches will be creators' covers rather than the original
  recordings, because that is what Instagram's business library holds.
  The why line says so. A cover's rights are Instagram's business: we only
  attach sounds `/ig_audio` returns for the account, by id, as before.
- Matching is limited by Instagram's search, which returns 25 results with
  no paging. A song whose cover is not in the top 25 for its title is
  missed. Strict thresholds also trade recall for never pairing a
  stranger's song with a playlist's popularity.
- The trending rank and `bpm` are only as fresh as the last run.
- If Spotify ever grants extended quota and written permission, a source
  can produce the same snapshot shape and nothing downstream changes.

## What the owner must set up

1. A licensed source of playlist data (or hand curation from public
   listings) that produces the snapshot JSON. No Spotify app or keys are
   needed or used.
2. Apply the migration (`prisma migrate deploy`); ship.sh does not apply
   it.
3. Run the job against prod with the @reelwalking workspace (its connected
   Instagram business account does the searches):
   `DATABASE_URL=… pnpm --filter @reelwalk/worker music-chart --snapshot <file|https URL> --workspace <id>`.
   Use `--dry-run` first to read the picks.

## What was verified

- Unit tests:
  - `packages/core/tests/music-picks.test.ts` (28 tests): scoring maths,
    playlist and position dedupe, ISRC and title merging, normalisation, 12
    matcher fixtures (6 true and 6 false positives) plus strictness cases,
    best-match order, `matchCandidates` with a mocked search including
    failures, moods from words, looks and a timeline, and the picks and why
    line.
  - `apps/worker/tests/music-chart.test.ts` (5 tests): the job with mocked
    Instagram and store, the no-account and dry-run cases, a malformed
    snapshot, and pacing.
- The job's command line was run as a dry run against the local pretend
  Instagram, with a two-playlist snapshot and no database reachable. It
  matched 3 of 4 songs and printed picks per mood, and the tempo lookup
  failed without stopping the run.
- `prisma migrate diff --from-empty` generates the same columns and indexes
  as the hand-written migration.
- Not verified:
  - The row in a browser (no local stack was running).
  - Any call to the real Instagram API with these searches.
  - Any real snapshot.
