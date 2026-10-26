import { describe, expect, it } from "vitest";
import { applyAiEditPlan, namesCuts, type AiAsset, type AiEditOp, type AiSong } from "../src/ai-edit";
import { autopilotStyle, ruleCut } from "../src/autopilot";
import { applyFinish } from "../src/finishes";
import { CAPTION_SAFE } from "../src/guards";
import { SAFE_AREA, instagramIssues } from "../src/instagram";
import { REPACE_FLOOR_MS, paceTimeline } from "../src/pacing";
import { ROOM_LABEL_Y, TEXT_SAFE_BOTTOM, addRoomLabels, clipDurationMs, parseTimeline, timelineDurationMs, type Timeline } from "../src/timeline";
import { retimeTexts } from "../src/text-timing";

// The four plain defects in the default cut (2026-10-26 diagnosis): the 100 ms title, the Pop length
// collapse, the mid-clip splitter, and the safe-zone constants with room labels.

const video = (id: string, title: string, durationMs: number): AiAsset => ({ id, kind: "VIDEO", title, durationMs, isPano: false, bpm: null, beatOffsetMs: null });

// ── 1. The 100 ms title ─────────────────────────────────────────

describe("an opening title on a clip whose window moves", () => {
  // The specimen: the aerial played source 3.8–10.2 s with both opening titles on it; Pop moved its window to the middle.
  const rest = ["exterior", "living", "kitchen", "bed", "bath", "pool"].map((name, i) => ({ id: name, assetId: `v-${name}`, kind: "VIDEO", sourceStartMs: 1000, sourceEndMs: 4300 + i * 100 }));
  const before = parseTimeline({
    version: 1,
    clips: [{ id: "aerial", assetId: "v-aerial", kind: "VIDEO", sourceStartMs: 3800, sourceEndMs: 10232 }, ...rest],
    texts: [
      { id: "t1", text: "Live above it all", startMs: 0, endMs: 3000, style: "headline", y: 0.42 },
      { id: "t2", text: "Just listed", startMs: 0, endMs: 3000, style: "tag", y: 0.3 },
    ],
    music: null,
  });
  const shifted: Timeline = { ...before, clips: before.clips.map((clip) => (clip.id === "aerial" ? { ...clip, sourceStartMs: 6481, sourceEndMs: 7551 } : clip)) };

  it("stays on the first frames and keeps its length instead of shrinking to 100 ms", () => {
    const after = retimeTexts(before, shifted);
    for (const id of ["t1", "t2"]) {
      const title = after.texts.find((text) => text.id === id)!;
      expect(title.startMs).toBe(0);
      expect(title.endMs - title.startMs).toBeGreaterThanOrEqual(1500);
    }
    expect(after.texts.find((text) => text.id === "t1")!.endMs).toBe(3000);
  });

  it("is never left shorter than 1.5 s when the change would cut it shorter", () => {
    const short = parseTimeline({ ...before, texts: [{ id: "t1", text: "Hello", startMs: 0, endMs: 3000, style: "headline" }] });
    // Every clip becomes 700 ms: the reel is 4.9 s, the title must still read.
    const squeezed: Timeline = { ...short, clips: short.clips.map((clip) => ({ ...clip, sourceStartMs: 1000, sourceEndMs: 1700 })), texts: [{ ...short.texts[0], endMs: 400 }] };
    const after = retimeTexts(short, squeezed);
    const title = after.texts[0];
    expect(title.endMs - title.startMs).toBeGreaterThanOrEqual(1500);
  });

  it("keeps a title the user set short exactly that short", () => {
    const quick = parseTimeline({ ...before, texts: [{ id: "q", text: "Now", startMs: 0, endMs: 600, style: "headline" }] });
    const after = retimeTexts(quick, { ...quick, clips: shifted.clips });
    expect(after.texts[0]).toMatchObject({ startMs: 0, endMs: 600 });
  });

  it("a title in the middle of a clip is not shrunk below 1.2 s when the clip's start moves past it", () => {
    const mid = parseTimeline({
      version: 1,
      clips: [{ id: "a", assetId: "v-a", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 8000 }, { id: "b", assetId: "v-b", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 4000 }],
      texts: [{ id: "m", text: "Pool", startMs: 1000, endMs: 3000, style: "elegant" }],
      music: null,
    });
    // The clip now starts 1.5 s later in its source: the title's picture begins before the window.
    const trimmed: Timeline = { ...mid, clips: mid.clips.map((clip) => (clip.id === "a" ? { ...clip, sourceStartMs: 1500 } : clip)) };
    const title = retimeTexts(mid, trimmed).texts[0];
    expect(title.startMs).toBe(0);
    expect(title.endMs - title.startMs).toBeGreaterThanOrEqual(1200);
  });
});

// ── 2. Pop / pace length guard ──────────────────────────────────

describe("a re-pace keeps the reel's length", () => {
  const lengths = [22100, 9900, 12800, 8200, 7800, 6300, 5900];
  const names = ["aerial", "exterior", "living", "bed", "kitchen", "bath", "pool"];
  const durations: Record<string, number> = { song: 180000 };
  names.forEach((name, i) => (durations[`v-${name}`] = lengths[i]));
  // The specimen's shoot before Pop: about 28 s of windows, at 111.9 bpm, all inside the song's first build section.
  const windows = [6432, 6400, 4300, 4300, 2145, 2100, 2300];
  const reel = (extra = {}): Timeline =>
    parseTimeline({
      version: 1,
      clips: names.map((name, i) => ({ id: name, assetId: `v-${name}`, kind: "VIDEO", sourceStartMs: 1000, sourceEndMs: 1000 + windows[i], volume: 0 })),
      texts: [],
      music: { assetId: "song", sourceStartMs: 0, volume: 0.8, bpm: 111.9, beatOffsetMs: 0, sections: [{ kind: "build", startMs: 0, endMs: 55762 }], ...extra },
    });
  const before = timelineDurationMs(reel());

  it("without the guard, a hype pace collapses this reel (the specimen)", () => {
    const collapsed = paceTimeline(reel(), { energy: 0.85, sourceDurationsMs: durations, minTotalMs: 0 });
    expect(timelineDurationMs(collapsed)).toBeLessThan(10_000);
  });

  it("with it, the reel stays at 15 s or its previous length, whichever is smaller, and the shots differ", () => {
    expect(before).toBeGreaterThan(REPACE_FLOOR_MS);
    const paced = paceTimeline(reel(), { energy: 0.85, sourceDurationsMs: durations });
    expect(timelineDurationMs(paced)).toBeGreaterThanOrEqual(REPACE_FLOOR_MS);
    const lengthsMs = paced.clips.map(clipDurationMs);
    expect(new Set(lengthsMs.map((ms) => Math.round(ms / 100))).size).toBeGreaterThan(2);
    // The establishing and closing shots are among the longest.
    const middle = lengthsMs.slice(1, -1);
    expect(lengthsMs[0]).toBeGreaterThanOrEqual(Math.max(...middle) - 1);
    expect(lengthsMs.at(-1)!).toBeGreaterThanOrEqual(Math.min(...middle));
    expect(paced.clips.map((clip) => clip.id)).toEqual(names);
  });

  it("a reel shorter than 15 s keeps its own length", () => {
    const small = parseTimeline({ ...reel(), clips: reel().clips.slice(0, 4).map((clip) => ({ ...clip, sourceEndMs: clip.sourceStartMs + 1800 })) });
    const was = timelineDurationMs(small);
    expect(was).toBeLessThan(REPACE_FLOOR_MS);
    const paced = paceTimeline(small, { energy: 0.85, sourceDurationsMs: durations });
    expect(timelineDurationMs(paced)).toBeGreaterThanOrEqual(was - 600);
  });

  it("Make it pop does not shrink the reel without a song tempo either", () => {
    const flat = parseTimeline({ ...reel(), music: null });
    const popped = applyFinish(flat, "pop", { sourceDurationsMs: durations });
    expect(timelineDurationMs(popped)).toBeGreaterThanOrEqual(Math.min(REPACE_FLOOR_MS, timelineDurationMs(flat)) - 1);
  });

  it("Make it pop with a song keeps the reel at 15 s", () => {
    const popped = applyFinish(reel(), "pop", { sourceDurationsMs: durations });
    expect(timelineDurationMs(popped)).toBeGreaterThanOrEqual(REPACE_FLOOR_MS);
  });
});

// ── 3. No mid-clip splitter ─────────────────────────────────────

describe("the rule cut", () => {
  const titles = ["Aerial_Drone", "Exterior_Front", "Living", "Kitchen", "Bedroom", "Bath", "Pool_View"];
  const assets: Record<string, AiAsset> = Object.fromEntries(titles.map((title, i) => [`a${i}`, video(`a${i}`, title, 20000 - i * 1000)]));
  const picked = (count: number): Timeline =>
    parseTimeline({
      version: 1,
      clips: titles.slice(0, count).map((_, i) => ({ id: `c${i}`, assetId: `a${i}`, kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 20000 - i * 1000, room: titles[i].split("_")[0].toLowerCase() })),
      texts: [],
      music: null,
    });
  let n = 0;
  const cut = (timeline: Timeline, styleId = "just-listed") => ruleCut(timeline, { assets, songs: [] as AiSong[], info: {}, style: autopilotStyle(styleId), newId: () => `n${++n}` });

  it("makes one shot per source clip when there are three or more", () => {
    const result = cut(picked(7));
    expect(result.clips).toHaveLength(7);
    expect(new Set(result.clips.map((clip) => clip.assetId)).size).toBe(7);
  });

  it("with fewer than three clips, gives a long clip at most two windows, with a gap between them", () => {
    const result = cut(picked(2));
    for (const asset of ["a0", "a1"]) {
      const windows = result.clips.filter((clip) => clip.assetId === asset);
      expect(windows.length).toBeLessThanOrEqual(2);
      if (windows.length === 2) expect(windows[1].sourceStartMs - windows[0].sourceEndMs).toBeGreaterThan(1000);
    }
    expect(result.clips.length).toBeGreaterThan(2);
  });

  it("picks no filter and no transition effect", () => {
    const result = cut(picked(7));
    expect(result.clips.every((clip) => clip.filter === "none")).toBe(true);
    expect(result.clips.every((clip) => clip.transitionIn === "cut")).toBe(true);
  });

  it("leaves room labels off", () => {
    expect(cut(picked(7)).texts.some((text) => text.id.startsWith("room-"))).toBe(false);
  });
});

// ── 4. One safe-zone constant, labels off by default ────────────

describe("the safe zone", () => {
  it("is one value everywhere", () => {
    expect(TEXT_SAFE_BOTTOM).toBe(0.72);
    expect(CAPTION_SAFE.bottom).toBe(TEXT_SAFE_BOTTOM);
    expect(SAFE_AREA.bottom).toBe(TEXT_SAFE_BOTTOM);
    expect(ROOM_LABEL_Y).toBeLessThan(TEXT_SAFE_BOTTOM);
  });

  const labelled = parseTimeline({
    version: 1,
    clips: [
      { id: "c1", assetId: "a", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 3000, room: "aerial" },
      { id: "c2", assetId: "b", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 3000, room: "exterior" },
      { id: "c3", assetId: "c", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 3000, room: "ocean view" },
      { id: "c4", assetId: "d", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 3000, room: "drone" },
      { id: "c5", assetId: "e", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 3000, room: "kitchen" },
      { id: "c6", assetId: "f", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 3000, room: "primary bedroom" },
    ],
    texts: [],
    music: null,
  });

  it("room labels sit at y 0.66 and are never made for aerial, exterior, view or drone shots", () => {
    const labels = addRoomLabels(labelled).texts.filter((text) => text.id.startsWith("room-"));
    expect(labels.map((label) => label.text.toLowerCase())).toEqual(["kitchen", "primary bedroom"]);
    expect(labels.every((label) => label.y === 0.66)).toBe(true);
  });

  it("the export check does not flag a label the app placed itself", () => {
    const issues = instagramIssues(addRoomLabels(labelled));
    expect(issues.filter((issue) => issue.code === "text-unsafe")).toEqual([]);
  });

  it("the starting values of every style have room labels off", () => {
    for (const id of ["just-listed", "privacy", "open-house", "walkthrough"]) expect(autopilotStyle(id).roomLabels).toBe(false);
  });
});

// ── Effect transitions ──────────────────────────────────────────

describe("an ask for speed ramps or whips", () => {
  const assets: Record<string, AiAsset> = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`a${i}`, video(`a${i}`, `shot ${i}`, 10000)]));
  const reel = (): Timeline =>
    parseTimeline({ version: 1, clips: Array.from({ length: 8 }, (_, i) => ({ id: `c${i}`, assetId: `a${i}`, kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 3000 })), texts: [], music: null });
  const blank: Omit<AiEditOp, "op"> = {
    clip: null, text: null, startMs: null, endMs: null, lengthMs: null, speed: null, filter: null, motion: null, transition: null, fit: null,
    volume: null, toPosition: null, content: null, style: null, color: null, size: null, y: null, songId: null, on: null, details: null,
    assetId: null, order: null, pieces: null, atClip: null, animation: null, zoom: null, corner: null, yaw: null, sweep: null,
  };
  const run = (ops: Partial<AiEditOp> & { op: AiEditOp["op"] }, namedCuts = false) => applyAiEditPlan(reel(), { ops: [{ ...blank, ...ops }], note: "" }, { assets, songs: [], namedCuts });
  const effects = (timeline: Timeline) => timeline.clips.filter((clip) => clip.transitionIn === "focusPull" || clip.transitionIn === "softDissolve" || clip.transitionIn === "lightLeak");

  it("puts a focus pull on at most two cuts, the rest stay cuts", () => {
    const { timeline, skipped } = run({ op: "transition", clip: 0, transition: "focusPull" });
    expect(effects(timeline).length).toBe(2);
    expect(timeline.clips[0].transitionIn).toBe("cut");
    expect(skipped.join(" ")).toMatch(/only 2 cuts/);
  });

  it("does the same for a soft dissolve and a light leak", () => {
    expect(effects(run({ op: "transition", clip: 0, transition: "softDissolve" }).timeline).length).toBe(2);
    expect(effects(run({ op: "transition", clip: 0, transition: "lightLeak" }).timeline).length).toBe(2);
  });

  it("applies one to every cut when the user names them", () => {
    expect(effects(run({ op: "transition", clip: 0, transition: "softDissolve" }, true).timeline).length).toBe(7);
  });

  it("leaves fades alone", () => {
    expect(run({ op: "transition", clip: 0, transition: "fade" }).timeline.clips.filter((clip) => clip.transitionIn === "fade").length).toBe(7);
  });

  it("counts several single-clip ops against the same limit", () => {
    const ops = [2, 3, 4, 5].map((clip) => ({ ...blank, op: "transition" as const, clip, transition: "focusPull" as const }));
    const { timeline } = applyAiEditPlan(reel(), { ops, note: "" }, { assets, songs: [] });
    expect(effects(timeline).length).toBe(2);
  });

  it("recognises a request that names cuts", () => {
    expect(namesCuts("add a whip between clip 2 and 3")).toBe(true);
    expect(namesCuts("a speed ramp into the kitchen")).toBe(true);
    expect(namesCuts("the last cut should whip")).toBe(true);
    expect(namesCuts("speed ramps where appropriate")).toBe(false);
    expect(namesCuts("smooth transitions")).toBe(false);
  });
});
