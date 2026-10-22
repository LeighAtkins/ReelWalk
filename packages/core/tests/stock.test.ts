import { describe, expect, it } from "vitest";
import { matchLook } from "../src/look";
import {
  creatorFromCredit,
  groupStock,
  passesStockFilters,
  reelSources,
  sourcesCaption,
  stockSource,
  tagsSuggestPeople,
  transformScore,
  untouchedStockClips,
  type StockClip,
} from "../src/stock";
import { parseTimeline, type Timeline } from "../src/timeline";

// Stock as sets with a licence trail, and the transform check (ADR 0070).

function clip(id: number, creator: string, tags: string[], extra: Partial<StockClip> = {}): StockClip {
  return {
    source: "pixabay", id: String(id), creator, creatorId: creator.toLowerCase(), url: `https://pixabay.com/videos/${id}/`, poster: "",
    file: { url: `https://cdn/${id}.mp4`, width: 1080, height: 1920 }, durationMs: 8000, width: 1080, height: 1920, tags, ...extra,
  };
}

describe("groupStock", () => {
  it("puts one creator's clips of one place together and other creators apart", () => {
    const hits = [
      clip(100, "Ana", ["villa", "pool", "sunset", "terrace"]),
      clip(101, "Ana", ["villa", "pool", "bedroom", "terrace"]),
      clip(5000, "Ana", ["forest", "river", "mist"]),
      clip(102, "Ben", ["villa", "pool", "sunset"]),
      clip(7000, "Ana", ["villa", "pool", "sunset", "terrace"]),
    ];
    const groups = groupStock(hits);
    const ana = groups.filter((group) => group.creator === "Ana");
    expect(ana).toHaveLength(2);
    // Largest set first: the villa (three clips: two uploaded together, one later with the same tags).
    expect(groups[0].clips.map((c) => c.id)).toEqual(["100", "101", "7000"]);
    expect(groups[0].label).toBe("pool, terrace, villa");
    expect(groups[0].key).toBe("pixabay:ana:100");
    expect(ana[1].clips.map((c) => c.id)).toEqual(["5000"]);
    expect(groups.find((group) => group.creator === "Ben")!.clips).toHaveLength(1);
  });

  it("links consecutive uploads that share any tag, not unrelated ones", () => {
    const groups = groupStock([clip(10, "Cy", ["kitchen", "marble"]), clip(12, "Cy", ["kitchen", "oak", "morning"]), clip(14, "Cy", ["dog", "beach"])]);
    expect(groups.map((group) => group.clips.length).sort()).toEqual([1, 2]);
  });

  it("prefers a checked place for the label", () => {
    const [group] = groupStock([clip(1, "Di", ["house"], { checks: { people: false, text: false, place: "white kitchen, marble island", framesChecked: 3 } })]);
    expect(group.label).toBe("white kitchen, marble island");
  });
});

describe("filters", () => {
  it("reads tags when no check ran, and the check when one did", () => {
    const tagged = clip(1, "E", ["woman", "kitchen"]);
    expect(tagsSuggestPeople(tagged.tags)).toBe(true);
    expect(passesStockFilters(tagged, { noPeople: true })).toBe(false);
    expect(passesStockFilters({ ...tagged, checks: { people: false, text: false, place: null, framesChecked: 3 } }, { noPeople: true })).toBe(true);
    expect(passesStockFilters(clip(2, "E", ["kitchen"], { checks: { people: true, text: null, place: null, framesChecked: 1 } }), { noPeople: true })).toBe(false);
    expect(passesStockFilters(clip(3, "E", ["logo"]), { noText: true })).toBe(false);
  });

  it("keeps portrait clips of the asked length", () => {
    expect(passesStockFilters(clip(1, "E", [], { width: 1920, height: 1080 }), { portrait: true })).toBe(false);
    expect(passesStockFilters(clip(1, "E", [], { durationMs: 2000 }), { minMs: 3000 })).toBe(false);
    expect(passesStockFilters(clip(1, "E", [], { durationMs: 40000 }), { maxMs: 30000 })).toBe(false);
    expect(passesStockFilters(clip(1, "E", []), { portrait: true, minMs: 3000, maxMs: 30000 })).toBe(true);
  });
});

describe("licence record", () => {
  it("reads source, id, creator, licence and import time off the asset", () => {
    const record = stockSource({ id: "m1", sourceUrl: "https://pixabay.com/videos/12345/", license: "Pixabay Content License", attribution: "Video by Ana Ruiz on Pixabay", createdAt: new Date("2026-10-22T08:00:00Z") });
    expect(record).toEqual({ assetId: "m1", source: "pixabay", id: "12345", creator: "Ana Ruiz", url: "https://pixabay.com/videos/12345/", license: "Pixabay Content License", importedAt: "2026-10-22T08:00:00.000Z" });
    expect(stockSource({ id: "m2", sourceUrl: "https://www.pexels.com/video/woman-reading-by-a-fire-6984912/", attribution: "Video by Cottonbro on Pexels" })!.source).toBe("pexels");
    expect(stockSource({ id: "m2", sourceUrl: "https://www.pexels.com/video/woman-reading-by-a-fire-6984912/" })!.id).toBe("6984912");
    expect(stockSource({ id: "m3", sourceUrl: null })).toBeNull();
    expect(stockSource({ id: "m4", sourceUrl: "https://polyhaven.com/a/abandoned_workshop", license: "CC0" })).toBeNull();
    expect(creatorFromCredit("Poly Haven")).toBe("Poly Haven");
  });

  it("lists a reel's sources once each with their clips, and writes the caption lines", () => {
    const timeline = parseTimeline({ version: 1, clips: [
      { id: "a", assetId: "s1", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 2000 },
      { id: "b", assetId: "own", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 2000 },
      { id: "c", assetId: "s1", kind: "VIDEO", sourceStartMs: 2000, sourceEndMs: 4000 },
      { id: "d", assetId: "s2", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 2000 },
    ], texts: [], music: null });
    const assets = {
      s1: { id: "s1", sourceUrl: "https://pixabay.com/videos/1/", attribution: "Video by Ana on Pixabay", license: "Pixabay Content License" },
      s2: { id: "s2", sourceUrl: "https://pixabay.com/videos/2/", attribution: "Video by Ben on Pixabay", license: "Pixabay Content License" },
      own: { id: "own", sourceUrl: null },
    };
    const sources = reelSources(timeline, assets);
    expect(sources.map((s) => [s.assetId, s.clipIds])).toEqual([["s1", ["a", "c"]], ["s2", ["d"]]]);
    expect(sourcesCaption(sources)).toBe("Footage: Ana, Ben via Pixabay");
    expect(sourcesCaption([])).toBe("");
  });
});

describe("transformScore", () => {
  const base = (): Timeline => parseTimeline({ version: 1, clips: [
    { id: "a", assetId: "s1", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 8000 },
    { id: "b", assetId: "s2", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 8000 },
  ], texts: [], music: null });

  it("is zero for a stock clip posted as downloaded", () => {
    const result = transformScore(base().clips[0], { sourceDurationMs: 8000 });
    expect(result.score).toBe(0);
    expect(result.untouched).toBe(true);
  });

  it("adds up the edits and caps at 1", () => {
    const timeline = parseTimeline({ ...base(), texts: [{ id: "t", text: "Open Saturday", startMs: 500, endMs: 2500, particles: { kind: "dust" } }] });
    const recut = transformScore({ ...timeline.clips[0], sourceEndMs: 2000 }, { sourceDurationMs: 8000 });
    expect(recut.signals.recut).toBeCloseTo(0.75, 2);
    expect(recut.score).toBeCloseTo(0.19, 2);
    expect(recut.untouched).toBe(true);
    const titled = transformScore(timeline.clips[0], { texts: timeline.texts, clipStartMs: 0, sourceDurationMs: 8000 });
    expect(titled.signals.text).toBe(1);
    expect(titled.untouched).toBe(false);
    const everything = transformScore({ ...timeline.clips[0], sourceEndMs: 2000, speed: 1.5, filter: "golden", zoom: 1.5, motion: "zoom-in", transitionIn: "whip", lensSoftness: 0.3 }, { texts: timeline.texts, clipStartMs: 0, sourceDurationMs: 8000 });
    expect(everything.score).toBe(1);
    // A title over the next clip does not count for this one.
    expect(transformScore(timeline.clips[1], { texts: timeline.texts, clipStartMs: 8000, sourceDurationMs: 8000 }).signals.text).toBe(0);
  });

  it("counts a colour match, and finds the untouched stock clips of a reel", () => {
    const stats = { mean: [0.4, 0.02, 0.05], std: [0.2, 0.05, 0.05] };
    const matched = matchLook(base(), { referenceClipId: "a", stats: { a: stats, b: { mean: [0.6, -0.05, -0.02], std: [0.15, 0.04, 0.04] } } });
    expect(transformScore(matched.clips[1]).signals.colorMatch).toBe(1);
    expect(transformScore(matched.clips[0]).signals.colorMatch).toBe(0);
    // A colour match alone (0.15) is not enough to count as transformed; a grade on top is.
    const flagged = untouchedStockClips(matched, (assetId) => assetId === "s1" || assetId === "s2", { s1: 8000, s2: 8000 });
    expect(flagged.map((f) => [f.clipId, f.score])).toEqual([["a", 0], ["b", 0.15]]);
    const graded = { ...matched, clips: matched.clips.map((c) => (c.id === "b" ? { ...c, filter: "crisp" as const } : c)) };
    expect(untouchedStockClips(graded, () => true).map((f) => f.clipId)).toEqual(["a"]);
    expect(untouchedStockClips(matched, () => false)).toEqual([]);
  });
});
