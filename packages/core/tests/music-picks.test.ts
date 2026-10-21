import { describe, expect, it, vi } from "vitest";
import {
  bestInstagramMatch,
  candidatesToMatch,
  chartFreshSince,
  isGraphRateLimit,
  emptyTimeline,
  formatFollowers,
  matchCandidates,
  matchInstagramSound,
  normaliseArtist,
  normaliseIsrc,
  normaliseTitle,
  pickPopularSounds,
  playlistSnapshotSchema,
  playlistWeight,
  positionWeight,
  reelMoodInput,
  reelMoods,
  scorePlaylistSnapshot,
  similarity,
  trendingBonus,
  variantWords,
  whyLine,
  type InstagramAudioTrack,
  type PopularSoundRow,
  type Timeline,
} from "../src";

/** "Popular now" (ADR 0058): playlist scoring, dedupe, the strict matcher, moods and the picks. */

const sound = (over: Partial<InstagramAudioTrack> & Pick<InstagramAudioTrack, "title">): InstagramAudioTrack => ({
  id: over.id ?? `ig-${over.title}`,
  type: "music",
  artist: null,
  durationMs: 90_000,
  coverUrl: null,
  previewUrl: null,
  ...over,
});

describe("scoring", () => {
  it("weighs slots and followers as documented", () => {
    expect(positionWeight(1)).toBe(1);
    expect(positionWeight(3)).toBeCloseTo(0.5, 10);
    expect(positionWeight(0)).toBe(1);
    expect(playlistWeight(0)).toBe(0);
    expect(playlistWeight(1_000_000)).toBeCloseTo(13.8155, 3);
    expect(playlistWeight(-5)).toBe(0);
    expect(trendingBonus(null)).toBe(0);
    expect(trendingBonus(1)).toBe(4);
  });

  it("sums log(followers) × position weight over playlists, plus popularity", () => {
    const snapshot = playlistSnapshotSchema.parse({
      source: "test",
      fetchedAt: "2026-10-21T00:00:00Z",
      playlists: [
        { id: "p1", name: "Cozy Winter Evenings", followers: 1_000_000, moods: ["cozy-winter"], tracks: [{ title: "A", artist: "X" }, { title: "B", artist: "Y", popularity: 80 }] },
        { id: "p2", name: "Chill Piano", followers: 1_000, moods: ["chill-piano"], tracks: [{ title: "B", artist: "Y" }] },
      ],
    });
    // B: 13.82 × 0.63 + 6.91 × 1 + 4 = 19.6 beats A's single top slot (13.82).
    const [second, first] = scorePlaylistSnapshot(snapshot);
    const a = Math.log(1_000_001) * 1;
    const b = Math.log(1_000_001) * (1 / Math.log2(3)) + Math.log(1_001) * 1 + 0.8 * 5;
    expect(first!.title).toBe("A");
    expect(first!.score).toBeCloseTo(a, 2);
    expect(second!.title).toBe("B");
    expect(second!.score).toBeCloseTo(b, 2);
    expect(second!.moods).toEqual(["cozy-winter", "chill-piano"]);
    expect(second!.playlists.map((playlist) => [playlist.name, playlist.position])).toEqual([["Cozy Winter Evenings", 2], ["Chill Piano", 1]]);
    expect(second!.popularity).toBe(80);
  });

  it("counts a playlist found by two searches once, and a repeated track at its best slot", () => {
    const playlist = { id: "p1", name: "Summer", followers: 5000, tracks: [{ title: "Sun", artist: "Ra" }, { title: "Sun", artist: "Ra" }] };
    const [only] = scorePlaylistSnapshot(
      playlistSnapshotSchema.parse({ source: "t", fetchedAt: "2026-10-21", playlists: [{ ...playlist, moods: ["summer-house"] }, { ...playlist, moods: ["deep-house"] }] }),
    );
    expect(only!.score).toBeCloseTo(Math.log(5001), 2);
    expect(only!.playlists).toHaveLength(1);
    expect(only!.moods).toEqual(["summer-house", "deep-house"]);
  });

  it("picks the best of each mood to look up, so small moods are not crowded out", () => {
    const candidates = [
      ...Array.from({ length: 20 }, (_, index) => ({ key: `big-${index}`, score: 100 - index, moods: ["luxury-home-tour" as const] })),
      { key: "small", score: 1, moods: ["cozy-winter" as const] },
    ];
    const chosen = candidatesToMatch(candidates, 3, 10);
    expect(chosen.map((entry) => entry.key)).toEqual(["big-0", "big-1", "big-2", "small"]);
  });
});

describe("dedupe", () => {
  it("merges spellings and releases of one song, keeps a remix apart", () => {
    const snapshot = playlistSnapshotSchema.parse({
      source: "t",
      fetchedAt: "2026-10-21",
      playlists: [
        {
          id: "p1",
          name: "One",
          followers: 100,
          moods: ["deep-house"],
          tracks: [
            { title: "Don't Start Now", artist: "Dua Lipa" },
            { title: "Dont Start Now - Remastered 2021", artist: "Dua Lipa, Someone" },
            { title: "Don’t Start Now (feat. Nobody)", artist: "Dua Lipa feat. Nobody" },
            { title: "Don't Start Now (Kygo Remix)", artist: "Dua Lipa" },
          ],
        },
      ],
    });
    const candidates = scorePlaylistSnapshot(snapshot);
    expect(candidates).toHaveLength(2);
    expect(candidates.map((candidate) => candidate.key).sort()).toEqual(["ta:dont start now kygo remix|dua lipa", "ta:dont start now|dua lipa"]);
  });

  it("merges by ISRC even when the titles differ, and keys by it", () => {
    const snapshot = playlistSnapshotSchema.parse({
      source: "t",
      fetchedAt: "2026-10-21",
      playlists: [
        { id: "p1", name: "One", followers: 100, moods: ["chill-piano"], tracks: [{ title: "Nuvole Bianche", artist: "Ludovico Einaudi" }] },
        { id: "p2", name: "Two", followers: 100, moods: ["chill-piano"], tracks: [{ title: "Nuvole bianche", artist: "Ludovico Einaudi", isrc: "gb-umj-04-01234" }] },
        { id: "p3", name: "Three", followers: 100, moods: ["chill-piano"], tracks: [{ title: "Nuvole Bianche (Live in Berlin)", artist: "Einaudi", isrc: "GBUMJ0401234" }] },
      ],
    });
    const candidates = scorePlaylistSnapshot(snapshot);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.key).toBe("isrc:GBUMJ0401234");
    expect(candidates[0]!.playlists).toHaveLength(3);
  });

  it("normalises titles, artists and ISRCs", () => {
    expect(normaliseTitle("Café del Mar - Energy 52 Remix")).toBe("cafe del mar energy 52 remix");
    expect(normaliseTitle("Wonderwall (Remastered)")).toBe("wonderwall");
    expect(normaliseTitle("Sunset Lover [Radio Edit]")).toBe("sunset lover");
    expect(normaliseTitle("Rock & Roll")).toBe("rock and roll");
    expect(normaliseTitle("Yesterday - 2009 Remaster")).toBe("yesterday");
    expect(normaliseTitle("Strobe (Original Mix)")).toBe("strobe");
    expect(normaliseTitle("Dance The Night (From Barbie The Album)")).toBe("dance the night");
    // Other recordings keep what makes them other.
    expect(normaliseTitle("Flowers (Instrumental Version)")).toBe("flowers instrumental version");
    expect(normaliseTitle("Die With A Smile (Sped Up Version)")).toBe("die with a smile sped up version");
    expect(normaliseTitle("Someone Like You - Live at the Royal Albert Hall")).toBe("someone like you live at the royal albert hall");
    expect(normaliseTitle("Strobe (Extended Mix)")).toBe("strobe extended mix");
    expect(variantWords(normaliseTitle("Snooze (Slowed + Reverb)"))).toBe("reverb slowed");
    expect(variantWords("live forever")).toBe("live");
    expect(normaliseArtist("The Weeknd, Daft Punk")).toBe("weeknd");
    expect(normaliseArtist("Calvin Harris feat. Rihanna")).toBe("calvin harris");
    expect(normaliseArtist("@rabanmusik")).toBe("rabanmusik");
    expect(normaliseIsrc("us-rc1-17-00001")).toBe("USRC11700001");
    expect(normaliseIsrc("not an isrc")).toBeNull();
    expect(similarity("abc", "abc")).toBe(1);
    expect(similarity("", "abc")).toBe(0);
  });
});

describe("the Instagram matcher", () => {
  const song = { title: "Nuvole Bianche", artist: "Ludovico Einaudi" };

  it.each([
    ["the same recording", sound({ title: "Nuvole Bianche", artist: "Ludovico Einaudi" }), "track"],
    ["the same recording with a release suffix", sound({ title: "Nuvole Bianche - Remastered", artist: "Ludovico Einaudi, Orchestra" }), "track"],
    ["a one-letter typo", sound({ title: "Nuvole Bianchi", artist: "Ludovico Einaudi" }), "track"],
    ["a piano cover", sound({ type: "original_sound", title: "Nuvole Bianche piano cover", artist: "@david_spagarini" }), "cover"],
    ["a cover with its own credit", sound({ type: "original_sound", title: "Nuvole Bianche piano cover by David Spagarini", artist: "@david_spagarini" }), "cover"],
    ["an acoustic version by a creator", sound({ type: "original_sound", title: "Nuvole Bianche acoustic version by me", artist: "@someone" }), "cover"],
    ["a cover of", sound({ type: "original_sound", title: "Piano cover of Nuvole Bianche", artist: "@someone" }), "cover"],
  ])("matches %s", (_name, candidateSound, kind) => {
    expect(matchInstagramSound(song, candidateSound)?.kind).toBe(kind);
  });

  it.each([
    ["a soundalike stock track", sound({ title: "White Clouds", artist: "Stock Music Co" })],
    ["the same title by someone else", sound({ title: "Nuvole Bianche", artist: "Piano Bar Trio" })],
    ["a different title by the artist", sound({ title: "Una Mattina", artist: "Ludovico Einaudi" })],
    ["a longer title that contains it", sound({ title: "Nuvole Bianche Variations Medley", artist: "Ludovico Einaudi" })],
    ["a creator's sound with no cover word or artist", sound({ type: "original_sound", title: "Nuvole Bianche", artist: "@someone" })],
    ["original audio", sound({ type: "original_sound", title: "Original audio", artist: "@ludovicoeinaudi" })],
    // An artist's name is not a cover word: this is usually a rip of the record.
    ["a creator's sound naming the artist", sound({ type: "original_sound", title: "Ludovico Einaudi - Nuvole Bianche", artist: "@someone" })],
    ["a sped-up piano cover", sound({ type: "original_sound", title: "Nuvole Bianche piano cover sped up", artist: "@someone" })],
    ["a live recording", sound({ title: "Nuvole Bianche (Live)", artist: "Ludovico Einaudi" })],
  ])("rejects %s", (_name, candidateSound) => {
    expect(matchInstagramSound(song, candidateSound)).toBeNull();
  });

  it.each([
    [{ title: "Die With A Smile", artist: "Lady Gaga" }, sound({ title: "Die With A Smile (Sped Up Version)", artist: "Lady Gaga, Bruno Mars" })],
    [{ title: "Someone Like You", artist: "Adele" }, sound({ title: "Someone Like You - Live at the Royal Albert Hall", artist: "Adele" })],
    [{ title: "Flowers", artist: "Miley Cyrus" }, sound({ title: "Flowers (Instrumental Version)", artist: "Miley Cyrus" })],
    [{ title: "Shape of You", artist: "Ed Sheeran" }, sound({ type: "original_sound", title: "Shape of You Ed Sheeran", artist: "@ripper" })],
    [{ title: "Espresso", artist: "Sabrina Carpenter" }, sound({ title: "Espresso (Slowed + Reverb)", artist: "Sabrina Carpenter" })],
    [{ title: "Strobe", artist: "deadmau5" }, sound({ title: "Strobe (Extended Mix)", artist: "deadmau5" })],
    [{ title: "Levels", artist: "Avicii" }, sound({ title: "Levels (Skrillex Remix)", artist: "Avicii" })],
  ])("never calls another version the song: %o", (candidate, candidateSound) => {
    expect(matchInstagramSound(candidate, candidateSound)).toBeNull();
  });

  it("still matches the same version on both sides", () => {
    expect(matchInstagramSound({ title: "Levels (Skrillex Remix)", artist: "Avicii" }, sound({ title: "Levels - Skrillex Remix", artist: "Avicii" }))?.kind).toBe("track");
    expect(matchInstagramSound({ title: "Yesterday", artist: "The Beatles" }, sound({ title: "Yesterday - Remastered 2009", artist: "The Beatles" }))?.kind).toBe("track");
  });

  it("is strict with near titles and one-word titles", () => {
    expect(matchInstagramSound({ title: "Levitating", artist: "Dua Lipa" }, sound({ title: "Elevating", artist: "Dua Lipa" }))).toBeNull();
    // "Experience" is too common a word to trust a cover without the artist named.
    expect(matchInstagramSound({ title: "Experience", artist: "Ludovico Einaudi" }, sound({ type: "original_sound", title: "Experience piano", artist: "@rabanmusik" }))).toBeNull();
    expect(matchInstagramSound({ title: "Experience", artist: "Ludovico Einaudi" }, sound({ type: "original_sound", title: "Experience - Ludovico Einaudi (piano)", artist: "@rabanmusik" }))?.kind).toBe("cover");
    expect(matchInstagramSound({ title: "Stand By Me", artist: "Ben E. King" }, sound({ type: "original_sound", title: "Stand By Me piano version", artist: "@x" }))?.kind).toBe("cover");
    expect(matchInstagramSound({ title: "Stand By Me", artist: "Ben E. King" }, sound({ type: "original_sound", title: "Stand By Me cover by raban", artist: "@rabanmusik" }))?.kind).toBe("cover");
  });

  it("matches on ISRC whatever the spelling", () => {
    expect(matchInstagramSound({ title: "A", artist: "B", isrc: "GBUMJ0401234" }, { type: "music", title: "Totally different", artist: "C", isrc: "GB-UMJ-04-01234" })).toEqual({ kind: "track", confidence: 1 });
  });

  it("prefers the recording, then the surer match, and skips snippets", () => {
    const sounds = [
      sound({ id: "snippet", title: "Nuvole Bianche", artist: "Ludovico Einaudi", durationMs: 9_000 }),
      sound({ id: "cover", type: "original_sound", title: "Nuvole Bianche piano", artist: "@x" }),
      sound({ id: "typo", title: "Nuvole Bianchi", artist: "Ludovico Einaudi" }),
      sound({ id: "exact", title: "Nuvole Bianche", artist: "Ludovico Einaudi" }),
    ];
    expect(bestInstagramMatch(song, sounds)?.sound.id).toBe("exact");
    expect(bestInstagramMatch(song, sounds.slice(0, 2))?.sound.id).toBe("cover");
    expect(bestInstagramMatch(song, sounds.slice(0, 1))).toBeNull();
  });

  it("searches music then creators' sounds, stops at a recording, and keeps failed songs apart", async () => {
    const search = vi.fn(async (type: string, query: string) => {
      if (query.startsWith("Broken")) throw new Error("Graph said no");
      if (type === "music" && query === "Half Broken") throw new Error("Graph hiccup");
      if (type === "original_sound" && query === "Half Broken") return [sound({ id: "half", type: "original_sound", title: "Half Broken piano cover", artist: "@x" })];
      if (type === "music" && query.startsWith("Nuvole")) return [sound({ id: "rec", title: "Nuvole Bianche", artist: "Ludovico Einaudi" })];
      if (type === "original_sound" && query === "Sunset Lover") return [sound({ id: "cov", type: "original_sound", title: "Sunset Lover piano", artist: "@mr.purged" })];
      return [];
    });
    const { matches, checked, failed, searches, failures, stopped } = await matchCandidates(
      [
        { key: "a", isrc: null, ...song },
        { key: "b", isrc: null, title: "Sunset Lover", artist: "Petit Biscuit" },
        { key: "c", isrc: null, title: "Broken Song", artist: "Nobody" },
        { key: "d", isrc: null, title: "Half Broken", artist: "Someone" },
        { key: "e", isrc: null, title: "Nothing Here", artist: "Nobody" },
      ],
      search,
    );
    expect(matches.get("a")?.sound.id).toBe("rec");
    expect(matches.get("b")?.match.kind).toBe("cover");
    // Both searches failed, or the recording search failed: no answer, so the stored match must stand.
    expect([...failed].sort()).toEqual(["c", "d"]);
    expect(matches.has("c") || matches.has("d")).toBe(false);
    // Searched fully and found nothing: that is an answer.
    expect([...checked].sort()).toEqual(["a", "b", "e"]);
    expect(searches).toBe(9);
    expect(failures).toBe(3);
    expect(stopped).toBeNull();
    expect(search).toHaveBeenCalledWith("music", "Nuvole Bianche");
  });
});

describe("rate limiting", () => {
  it("recognises Graph's slow-down answers", () => {
    expect(isGraphRateLimit({ status: 429, code: null })).toBe(true);
    for (const code of [4, 17, 32, 613]) expect(isGraphRateLimit({ status: 400, code })).toBe(true);
    expect(isGraphRateLimit({ status: 400, code: 100 })).toBe(false);
    expect(isGraphRateLimit(new Error("network"))).toBe(false);
    expect(isGraphRateLimit(null)).toBe(false);
  });

  it("stops the run at once and leaves later songs unchecked", async () => {
    const limited = Object.assign(new Error("Application request limit reached"), { status: 400, code: 4 });
    const search = vi.fn(async (_type: string, query: string) => {
      if (query === "Second") throw limited;
      return [];
    });
    const run = await matchCandidates(
      ["First", "Second", "Third"].map((title) => ({ key: title, isrc: null, title, artist: "A" })),
      search,
      { stopOn: isGraphRateLimit },
    );
    expect(run.stopped).toBe("Application request limit reached");
    expect([...run.checked]).toEqual(["First"]);
    expect(run.failed.size).toBe(0);
    expect(search).toHaveBeenCalledTimes(3);
  });
});

describe("chart age", () => {
  it("offers snapshots up to 45 days old", () => {
    expect(chartFreshSince(new Date("2026-10-21T00:00:00Z")).toISOString()).toBe("2026-09-06T00:00:00.000Z");
  });
});

describe("moods", () => {
  it("reads a reel's title, rooms, words and looks", () => {
    expect(reelMoods({ title: "Snowy lodge weekend", words: ["living room", "fireplace"] })).toEqual(["cozy-winter"]);
    expect(reelMoods({ title: "", words: ["Pool", "kitchen", "Penthouse living"] })).toEqual(["luxury-home-tour", "summer-house"]);
    expect(reelMoods({ title: "Just listed!", words: [] })).toEqual(["upbeat-real-estate"]);
    expect(reelMoods({ title: null, words: ["kitchen", "bedroom"] })).toEqual(["luxury-home-tour"]);
    // A look alone is not a mood; with a word it tips the balance.
    expect(reelMoods({ words: [], filters: ["cool"] })).toEqual(["luxury-home-tour"]);
    expect(reelMoods({ words: ["cabin", "pool"], filters: ["cool"] })).toEqual(["cozy-winter", "summer-house"]);
    // Whole words only: "spool" is not a pool.
    expect(reelMoods({ words: ["spool"] })).toEqual(["luxury-home-tour"]);
  });

  it("collects the words from a timeline", () => {
    const timeline: Timeline = {
      ...emptyTimeline(),
      clips: [{ room: "kitchen", filter: "cool" }, { room: null, filter: "none" }] as unknown as Timeline["clips"],
      texts: [{ text: "Ski in, ski out" }] as unknown as Timeline["texts"],
    };
    expect(reelMoodInput(timeline, "Alpine chalet")).toEqual({ title: "Alpine chalet", words: ["kitchen", "Ski in, ski out"], filters: ["cool", "none"] });
    expect(reelMoods(reelMoodInput(timeline, "Alpine chalet"))).toEqual(["cozy-winter"]);
  });
});

describe("picks for a reel", () => {
  const row = (over: Partial<PopularSoundRow> & Pick<PopularSoundRow, "key">): PopularSoundRow => ({
    title: over.key,
    artist: "Artist",
    score: 10,
    moods: ["cozy-winter"],
    playlists: [{ name: "Cozy Winter Evenings", followers: 2_100_000 }],
    igAudioId: `ig-${over.key}`,
    igAudioType: "music",
    igTitle: over.key,
    igArtist: "Artist",
    igDurationMs: 60_000,
    igMatch: "track",
    trendingRank: null,
    bpm: null,
    ...over,
  });

  it("offers the reel's moods only, long-enough sounds before short ones", () => {
    const rows = [
      row({ key: "off", moods: ["deep-house"], score: 100 }),
      row({ key: "short", score: 50, igDurationMs: 20_000 }),
      row({ key: "fits", score: 30 }),
      row({ key: "snippet", score: 99, igDurationMs: 8_000 }),
      row({ key: "dupe", score: 5, igAudioId: "ig-fits" }),
    ];
    const picks = pickPopularSounds(rows, { moods: ["cozy-winter"], reelMs: 30_000 });
    expect(picks.map((pick) => pick.track.id)).toEqual(["ig-fits", "ig-short"]);
    expect(pickPopularSounds(rows, { moods: ["cozy-winter"], reelMs: 30_000, limit: 1 })).toHaveLength(1);
    // The second mood counts, a little less.
    expect(pickPopularSounds(rows, { moods: ["cozy-winter", "deep-house"], reelMs: 30_000 }).map((pick) => pick.track.id)).toEqual(["ig-off", "ig-fits", "ig-short"]);
    // Nothing for the mood at all: the chart's best, rather than an empty row.
    expect(pickPopularSounds(rows, { moods: ["summer-house"], reelMs: 30_000 }).map((pick) => pick.track.id)).toEqual(["ig-off", "ig-fits", "ig-short"]);
  });

  it("only ever returns stored sounds, shaped for the Music sheet", () => {
    const [pick] = pickPopularSounds([row({ key: "a", bpm: 92, igAudioType: "original_sound", igArtist: "@x", igMatch: "cover" })], { moods: [], reelMs: 0 });
    expect(pick).toEqual({
      track: { id: "ig-a", type: "original_sound", title: "a", artist: "@x", durationMs: 60_000, coverUrl: null, previewUrl: null },
      why: "Cover of a song in Cozy Winter Evenings, 2.1M followers",
      bpm: 92,
      match: "cover",
    });
    expect(pickPopularSounds([], { moods: ["cozy-winter"], reelMs: 10_000 })).toEqual([]);
  });

  it("explains itself from the data", () => {
    expect(
      whyLine({
        igMatch: "track",
        trendingRank: 3,
        playlists: [
          { name: "Small", followers: 100_000 },
          { name: "Cozy Winter Evenings", followers: 1_500_000 },
          { name: "Other", followers: 500_000 },
        ],
      }),
    ).toBe("In 3 playlists like Cozy Winter Evenings, 2.1M followers, trending on Instagram");
    expect(whyLine({ igMatch: "track", trendingRank: 1, playlists: [] })).toBe("Trending on Instagram");
    expect(formatFollowers(2_100_000)).toBe("2.1M");
    expect(formatFollowers(45_300)).toBe("45.3K");
    expect(formatFollowers(450_000)).toBe("450K");
    expect(formatFollowers(950)).toBe("950");
  });
});
