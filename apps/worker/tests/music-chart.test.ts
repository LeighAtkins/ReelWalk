import { describe, expect, it, vi } from "vitest";
import type { InstagramAudioTrack } from "@reelwalk/core";
import {
  chartReplacementProblem,
  houseAccountProblem,
  mergeKeptMatches,
  pacedSearch,
  popularRowFromWrite,
  runMusicChart,
  storedMatch,
  type MusicCandidateWrite,
  type MusicChartStore,
  type StoredMatch,
} from "../src/music-chart";

/** The "Popular now" chart job (ADR 0058), with Instagram and the database mocked. */

const sound = (id: string, over: Partial<InstagramAudioTrack> = {}): InstagramAudioTrack => ({
  id,
  type: "music",
  title: id,
  artist: null,
  durationMs: 120_000,
  coverUrl: null,
  previewUrl: null,
  ...over,
});

const snapshot = {
  source: "hand-curated 2026-10-21",
  fetchedAt: "2026-10-21T09:00:00Z",
  playlists: [
    {
      id: "p1",
      name: "Cozy Winter Evenings",
      followers: 2_000_000,
      moods: ["cozy-winter"],
      tracks: [
        { title: "Nuvole Bianche", artist: "Ludovico Einaudi" },
        { title: "Sunset Lover", artist: "Petit Biscuit" },
        { title: "Nobody Has This", artist: "Unknown" },
      ],
    },
    { id: "p2", name: "Chill Piano", followers: 100_000, moods: ["chill-piano"], tracks: [{ title: "Nuvole Bianche", artist: "Ludovico Einaudi" }] },
  ],
};

const storedNuvole: StoredMatch = {
  key: "ta:nuvole bianche|ludovico einaudi",
  matchedAt: new Date("2026-10-01T00:00:00Z"),
  ig: { audioId: "ig-old", type: "music", title: "Nuvole Bianche", artist: "Ludovico Einaudi", durationMs: 90_000, match: "track", confidence: 1, trendingRank: null, bpm: null },
};

/** A store that saves the way the database store does (merge kept matches, guard), in memory. */
function memoryStore(options: { bpm?: Record<string, number>; stored?: StoredMatch[] } = {}) {
  const saved: MusicCandidateWrite[][] = [];
  const store: MusicChartStore = {
    bpmFor: vi.fn(async (ids: string[]) => new Map(ids.filter((id) => options.bpm?.[id]).map((id) => [id, options.bpm![id]!]))),
    save: vi.fn(async (rows: MusicCandidateWrite[], { force }: { force: boolean }) => {
      const problem = chartReplacementProblem(options.stored?.length ?? 0, rows.length, force);
      if (problem) throw new Error(problem);
      const merged = mergeKeptMatches(rows, options.stored ?? []);
      saved.push(merged.rows);
      return { written: merged.rows.length, removed: 0, kept: merged.kept };
    }),
  };
  return { store, saved };
}

describe("runMusicChart", () => {
  it("scores, matches strictly, ranks trending and stores", async () => {
    const search = vi.fn(async (type: string, query: string) => {
      if (query === "") return type === "music" ? [sound("stock-1"), sound("ig-nuvole")] : [];
      if (type === "music" && query === "Nuvole Bianche") return [sound("ig-nuvole", { title: "Nuvole Bianche", artist: "Ludovico Einaudi" })];
      if (type === "music" && query === "Nobody Has This") return [sound("ig-soundalike", { title: "Nobody Has That", artist: "Stock Co" })];
      if (type === "original_sound" && query === "Sunset Lover") return [sound("ig-cover", { type: "original_sound", title: "Sunset Lover piano", artist: "@mr.purged" })];
      return [];
    });
    const { store, saved } = memoryStore({ bpm: { "ig-nuvole": 70 } });
    const result = await runMusicChart({ snapshot, search, store, now: new Date("2026-10-21T10:00:00Z") });

    expect(result).toMatchObject({ songs: 3, lookedUp: 3, matched: 2, covers: 1, written: 3, failures: 0, stopped: null });
    const rows = saved[0]!;
    const nuvole = rows.find((row) => row.title === "Nuvole Bianche")!;
    expect(nuvole.ig).toMatchObject({ audioId: "ig-nuvole", match: "track", trendingRank: 2, bpm: 70 });
    expect(nuvole.moods).toEqual(["cozy-winter", "chill-piano"]);
    expect(nuvole.source).toBe("hand-curated 2026-10-21");
    expect(rows.find((row) => row.title === "Sunset Lover")!.ig).toMatchObject({ audioId: "ig-cover", match: "cover", trendingRank: null });
    // Searched fully and not found: that is an answer, the match is cleared.
    expect(rows.find((row) => row.title === "Nobody Has This")!.ig).toBeNull();
    expect(popularRowFromWrite(nuvole)).toMatchObject({ igAudioId: "ig-nuvole", playlists: [{ name: "Cozy Winter Evenings" }, { name: "Chill Piano" }] });
  });

  it("keeps a stored match when its search fails", async () => {
    const search = vi.fn(async (_type: string, query: string) => {
      if (query === "Nuvole Bianche") throw Object.assign(new Error("Service temporarily unavailable"), { status: 503, code: 2 });
      return [];
    });
    const { store, saved } = memoryStore({ stored: [storedNuvole] });
    const result = await runMusicChart({ snapshot, search, store });
    const nuvole = saved[0]!.find((row) => row.key === storedNuvole.key)!;
    expect(nuvole.ig).toEqual(storedNuvole.ig);
    expect(nuvole.matchedAt).toEqual(storedNuvole.matchedAt);
    expect(result).toMatchObject({ kept: 1, failures: 2, stopped: null });
  });

  it("stops on rate limiting with nothing written", async () => {
    const search = vi.fn(async (_type: string, query: string) => {
      if (query === "Sunset Lover") throw Object.assign(new Error("Application request limit reached"), { status: 400, code: 4 });
      return [];
    });
    const { store } = memoryStore({ stored: [storedNuvole] });
    const result = await runMusicChart({ snapshot, search, store });
    expect(store.save).not.toHaveBeenCalled();
    expect(result.stopped).toMatch(/rate limiting \(Application request limit reached\).*unchanged/);
    expect(result.written).toBe(0);
  });

  it("stops when even the trending lists are rate limited", async () => {
    const search = vi.fn(async () => {
      throw Object.assign(new Error("Too many calls"), { status: 429, code: null });
    });
    const { store } = memoryStore();
    const result = await runMusicChart({ snapshot, search, store });
    expect(search).toHaveBeenCalledTimes(1);
    expect(store.save).not.toHaveBeenCalled();
    expect(result.stopped).toMatch(/Too many calls/);
  });

  it("without an Instagram account, scores and stores and keeps stored matches", async () => {
    const { store, saved } = memoryStore({ stored: [storedNuvole] });
    const result = await runMusicChart({ snapshot, search: null, store });
    expect(result).toMatchObject({ songs: 3, lookedUp: 0, searches: 0, kept: 1 });
    expect(saved[0]!.find((row) => row.key === storedNuvole.key)!.ig?.audioId).toBe("ig-old");
  });

  it("writes nothing on a dry run, and refuses a malformed snapshot", async () => {
    const { store } = memoryStore();
    await runMusicChart({ snapshot, search: async () => [], store, dryRun: true });
    expect(store.save).not.toHaveBeenCalled();
    await expect(runMusicChart({ snapshot: { source: "x", playlists: [{ id: "p" }] }, search: null, store })).rejects.toThrow(/not valid/);
  });

  it("passes --force through to the guard", async () => {
    const stored = Array.from({ length: 10 }, (_, index) => ({ key: `old-${index}`, ig: null, matchedAt: null }));
    const { store } = memoryStore({ stored });
    await expect(runMusicChart({ snapshot, search: null, store })).rejects.toThrow(/under half of the 10 stored/);
    await expect(runMusicChart({ snapshot, search: null, store, force: true })).resolves.toMatchObject({ written: 3 });
  });
});

describe("save guards", () => {
  it("refuses to shrink the chart by more than half unless forced", () => {
    expect(chartReplacementProblem(0, 0, false)).toBeNull();
    expect(chartReplacementProblem(100, 50, false)).toBeNull();
    expect(chartReplacementProblem(100, 49, false)).toMatch(/--force/);
    expect(chartReplacementProblem(100, 1, true)).toBeNull();
  });

  it("merges stored matches only into songs not answered this run", () => {
    const base = { isrc: null, title: "t", artist: "a", score: 1, moods: [], playlists: [], source: "s", fetchedAt: new Date() };
    const fresh: MusicCandidateWrite = { ...base, key: storedNuvole.key, ig: null };
    const untouched: MusicCandidateWrite = { ...base, key: storedNuvole.key };
    expect(mergeKeptMatches([fresh], [storedNuvole])).toEqual({ rows: [fresh], kept: 0 });
    expect(mergeKeptMatches([untouched], [storedNuvole]).rows[0]!.ig?.audioId).toBe("ig-old");
    expect(mergeKeptMatches([{ ...untouched, key: "new" }], [storedNuvole]).rows[0]!.ig).toBeNull();
  });

  it("reads stored rows back, dropping malformed matches", () => {
    const row = { key: "k", igAudioId: "1", igAudioType: "music", igTitle: "T", igArtist: null, igDurationMs: 1, igMatch: "track", igConfidence: 0.95, trendingRank: 3, bpm: 120, matchedAt: null };
    expect(storedMatch(row).ig).toMatchObject({ audioId: "1", match: "track", trendingRank: 3 });
    expect(storedMatch({ ...row, igMatch: "guess" }).ig).toBeNull();
    expect(storedMatch({ ...row, igAudioId: null }).ig).toBeNull();
  });

  it("searches only with the house account", () => {
    expect(houseAccountProblem({ username: "reelwalking", expiresAt: null }, "reelwalking")).toBeNull();
    expect(houseAccountProblem({ username: "@ReelWalking", expiresAt: null }, "@reelwalking")).toBeNull();
    expect(houseAccountProblem({ username: "some.studio", expiresAt: null }, "reelwalking")).toMatch(/refusing/);
    expect(houseAccountProblem(null, "reelwalking")).toMatch(/no connected Instagram/);
    expect(houseAccountProblem({ username: "reelwalking", expiresAt: new Date("2026-01-01") }, "reelwalking", new Date("2026-10-21"))).toMatch(/expired/);
  });
});

describe("pacedSearch", () => {
  it("waits between calls", async () => {
    const sleep = vi.fn(async () => undefined);
    const search = pacedSearch(async () => [], 1500, sleep);
    await search("music", "a");
    await search("music", "b");
    expect(sleep).toHaveBeenCalledTimes(1);
    expect((sleep.mock.calls[0] as unknown as [number])[0]).toBeGreaterThan(1000);
  });
});
