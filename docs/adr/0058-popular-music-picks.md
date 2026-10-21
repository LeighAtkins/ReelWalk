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
  Normalising removes accents, credits ("feat.", "with", "From …") and
  bracketed or " - " notes that only name a release of the same recording
  ("Remastered 2011", "2009 Remaster", "Radio Edit", "Original Mix",
  "Album Version"). Everything that makes another recording stays in the
  title: sped up, slowed, reverb, live, instrumental, acoustic, remix,
  extended. The two keys are linked, so a copy with an ISRC and one without
  merge.

**Matching** (`matchInstagramSound`, deliberately strict; review of
2026-10-21 tightened it):

- **"track"**: an Instagram `music` sound with the same variant words as
  the song (so "Flowers (Instrumental Version)", "Die With A Smile (Sped Up
  Version)" and "Someone Like You - Live at the Royal Albert Hall" never
  match the studio song), title similarity ≥ 0.92 and first-artist
  similarity ≥ 0.85 (normalised Levenshtein), or the same ISRC.
- **"cover"**: an `original_sound` whose title carries an explicit cover
  word ("cover", an instrument such as "piano", or "acoustic/instrumental
  version by") and, once those words, a trailing "cover by X" credit and
  the artist's name are removed, matches the song's title at ≥ 0.95. The
  artist's name is never enough on its own: "Shape of You Ed Sheeran" is
  usually a rip of the record, which Instagram mutes. A sped-up, slowed,
  live or remixed cover does not match the song. A one-word song title
  ("Experience", "Home") also needs the artist's name.
- "Original audio" never matches, and sounds under 15 s (snippets) are
  skipped.
- Instagram is searched by title alone, since its search matches titles;
  the matcher checks the artist. Fixtures in the tests pin both the true
  and false positives, including the four from the review.

**The job** (`apps/worker/src/music-chart.ts`, run by
`scripts/music-chart.ts`) does the following, in order:

1. Scores the snapshot and keeps the top 1000 songs.
2. Looks up on Instagram the best 12 songs of each mood, at most 60 in
   all. It searches `music` first and `original_sound` only when no
   recording matched, 1.5 s apart, about 120 calls per run.
   - **House account only.** The token is the house workspace's
     (`MUSIC_HOUSE_WORKSPACE_ID`), and its connected account must be
     @reelwalking (`MUSIC_HOUSE_IG_USERNAME` to override). There is no
     option to name a workspace; `--workspace` is refused, and so is a house
     workspace connected to any other account.
   - **A failed search keeps the stored match.** A song is "checked" only
     when every search it needed answered (or a recording was found). A
     song with a failed search gets no new result, and its stored match is
     carried over. Only a song searched fully and not found loses its
     match.
   - **Rate limiting stops the run.** A 429 or Graph code 4, 17, 32 or 613,
     on any search including the trending lists, ends the run at once with
     nothing written (exit code 2). The stored chart is unchanged.
3. Records each sound's rank in Instagram's trending lists.
4. Copies the tempo of any copy of the sound someone has already analysed.
5. Replaces the chart in **one transaction** under a Postgres advisory lock
   (`pg_try_advisory_xact_lock`). A second run saving at the same time is
   refused and told to try again. Inside the transaction it reads the
   stored rows, refuses a snapshot with **under half as many songs as are
   stored** unless `--force` is given, carries over stored matches for
   songs not checked this run, then deletes the old rows and inserts the
   new ones. Readers see the old chart or the new one, never a mix.

`--dry-run` prints the top picks per mood. With `DEV_FAKE_INSTAGRAM=true`
it searches the local pretend library.

**Storage.** `MusicCandidate` is one global table, not per workspace,
added by migration `20261021040000_music_candidates`:

- the song: `key` (unique), `isrc`, `title`, `artist`, `score`, `moods`,
  `playlists`, `source`;
- the match: `igAudioId`, `igAudioType`, `igTitle`, `igArtist`,
  `igDurationMs`, `igMatch`, `igConfidence`;
- signals: `trendingRank`, `bpm`;
- times: `fetchedAt`, `matchedAt`.

The migration is additive only.

**The picks** (`pickPopularSounds`, behind `popularSounds` in
`apps/web/lib/music-picks.ts`):

- It reads only matched rows from snapshots at most 45 days old
  (`CHART_MAX_AGE_DAYS`): a stale chart is not "popular now", and the row
  disappears rather than show it.
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
3. Set `MUSIC_HOUSE_WORKSPACE_ID` to the @reelwalking workspace for the run.
   It is a workspace id, not a secret. Then run:
   `DATABASE_URL=… MUSIC_HOUSE_WORKSPACE_ID=… pnpm --filter @reelwalk/worker music-chart --snapshot <file|https URL>`.
   Use `--dry-run` first to read the picks. Rerun at least every 45 days,
   or the row disappears.

## What was verified

- Unit tests:
  - `packages/core/tests/music-picks.test.ts` (43 tests):
    - scoring maths, playlist and position dedupe, ISRC and title merging;
    - normalisation, including which version words stay;
    - matcher fixtures: 7 true positives, 9 false positives, and 7 "another
      version is not the song" cases (the review's four among them), plus
      strictness cases;
    - best-match order;
    - `matchCandidates` with a mocked search: checked vs failed songs, and
      stopping on rate limiting;
    - Graph rate-limit detection;
    - the 45-day cut-off;
    - moods from words, looks and a timeline;
    - the picks and why line.
  - `apps/worker/tests/music-chart.test.ts` (12 tests):
    - the job with mocked Instagram and store;
    - a stored match kept when its search fails;
    - rate limiting stopping the run with nothing written, including on the
      trending lists;
    - the no-account and dry-run cases, and a malformed snapshot;
    - the shrink guard and `--force`;
    - merging stored matches;
    - reading stored rows back;
    - the house-account check;
    - pacing.
- The job's command line was run as a dry run against the local pretend
  Instagram, with no database reachable. It matched 2 of 3 songs, printed
  picks per mood, and the tempo lookup failed without stopping the run.
  `--workspace` was refused.
- `prisma migrate diff --from-empty` generates the same columns and indexes
  as the hand-written migration.
- Not verified:
  - The row in a browser (no local stack was running).
  - Any call to the real Instagram API with these searches.
  - Any real snapshot.
  - The database store's transaction, advisory lock and swap against a
    real Postgres (no database was running). They are typechecked against
    the generated client only.
