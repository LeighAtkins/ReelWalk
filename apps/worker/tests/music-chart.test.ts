import { describe, expect, it, vi } from "vitest";
import type { InstagramAudioTrack } from "@reelwalk/core";
import { pacedSearch, popularRowFromWrite, runMusicChart, type MusicCandidateWrite, type MusicChartStore } from "../src/music-chart";

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

function memoryStore(bpm: Record<string, number> = {}) {
  const saved: MusicCandidateWrite[][] = [];
  const store: MusicChartStore = {
    bpmFor: vi.fn(async (ids: string[]) => new Map(ids.filter((id) => bpm[id]).map((id) => [id, bpm[id]!]))),
    save: vi.fn(async (rows: MusicCandidateWrite[]) => {
      saved.push(rows);
      return { written: rows.length, removed: 0 };
    }),
  };
  return { store, saved };
}

describe("runMusicChart", () => {
  it("scores, matches strictly, ranks trending and stores", async () => {
    const search = vi.fn(async (type: string, query: string) => {
      if (query === "") return type === "music" ? [sound("stock-1"), sound("ig-nuvole")] : [];
      if (type === "music" && query.startsWith("Nuvole Bianche")) return [sound("ig-nuvole", { title: "Nuvole Bianche", artist: "Ludovico Einaudi" })];
      if (type === "music" && query.startsWith("Nobody")) return [sound("ig-soundalike", { title: "Nobody Has That", artist: "Stock Co" })];
      if (type === "original_sound" && query === "Sunset Lover") return [sound("ig-cover", { type: "original_sound", title: "Sunset Lover piano", artist: "@mr.purged" })];
      return [];
    });
    const { store, saved } = memoryStore({ "ig-nuvole": 70 });
    const result = await runMusicChart({ snapshot, search, store, now: new Date("2026-10-21T10:00:00Z") });

    expect(result).toMatchObject({ songs: 3, lookedUp: 3, matched: 2, covers: 1, written: 3, failures: 0 });
    const rows = saved[0]!;
    const nuvole = rows.find((row) => row.title === "Nuvole Bianche")!;
    expect(nuvole.ig).toMatchObject({ audioId: "ig-nuvole", match: "track", trendingRank: 2, bpm: 70 });
    expect(nuvole.moods).toEqual(["cozy-winter", "chill-piano"]);
    expect(nuvole.source).toBe("hand-curated 2026-10-21");
    expect(rows.find((row) => row.title === "Sunset Lover")!.ig).toMatchObject({ audioId: "ig-cover", match: "cover", trendingRank: null });
    // Looked up and not found: the stored match is cleared, not kept.
    expect(rows.find((row) => row.title === "Nobody Has This")!.ig).toBeNull();
    expect(popularRowFromWrite(nuvole)).toMatchObject({ igAudioId: "ig-nuvole", playlists: [{ name: "Cozy Winter Evenings" }, { name: "Chill Piano" }] });
  });

  it("without an Instagram account, scores and stores but matches nothing and leaves stored matches alone", async () => {
    const { store, saved } = memoryStore();
    const result = await runMusicChart({ snapshot, search: null, store });
    expect(result).toMatchObject({ songs: 3, lookedUp: 0, matched: 0, searches: 0 });
    expect(saved[0]!.every((row) => row.ig === undefined)).toBe(true);
  });

  it("writes nothing on a dry run, and keeps going when Instagram fails", async () => {
    const { store } = memoryStore();
    const result = await runMusicChart({ snapshot, search: async () => { throw new Error("rate limited"); }, store, dryRun: true });
    expect(store.save).not.toHaveBeenCalled();
    expect(result).toMatchObject({ matched: 0, written: 0, failures: result.searches });
  });

  it("refuses a malformed snapshot", async () => {
    const { store } = memoryStore();
    await expect(runMusicChart({ snapshot: { source: "x", playlists: [{ id: "p" }] }, search: null, store })).rejects.toThrow(/not valid/);
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
