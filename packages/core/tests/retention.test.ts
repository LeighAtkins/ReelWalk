import { describe, expect, it } from "vitest";
import { applyCommand, type Command } from "../src/commands";
import { critique, criticSamples, type CriticFinding, type CriticFrame, type CriticSample } from "../src/critic";
import type { Measure, TitleFont } from "../src/scene";
import { frameExactSnap, isFrameExact, readingTimeMs, retentionFindings, RETENTION, seriesFromSamples, transformScoreOf, wantedShotBeats } from "../src/retention";
import { clipStartsMs, parseTimeline, type TextOverlay, type Timeline } from "../src/timeline";

// The retention critic (ADR 0071): each proxy on a fixture reel, the fix it offers, and the two old
// false positives (a shadow on a boxed title, a beat snap that lands off the frame grid) never firing.

const titleFont = (text: TextOverlay): TitleFont => ({ fontSize: 76 * text.size });
const measure: Measure = (line, font) => ({ width: line.length * font.fontSize * 0.55, height: font.fontSize * 1.12 });
const W = 18, H = 32;
const picture = (luma: number, seed = 0): CriticFrame => {
  const frame = { width: W, height: H, luma: new Float32Array(W * H) };
  frame.luma.forEach((_, i) => { frame.luma[i] = Math.min(1, Math.max(0, luma + 0.05 * Math.sin(i * 0.9 + seed))); });
  return frame;
};
const moving = (ms: number): CriticFrame => picture(0.5, ms / 50);
const framesFor = (timeline: Timeline, paint: (sample: CriticSample) => CriticFrame) => new Map(criticSamples(timeline).map((s) => [s.key, paint(s)]));
const run = (timeline: Timeline, extra: Record<string, unknown> = {}) => critique({ timeline, titleFont, measure, ...extra });
const ofCheck = (findings: CriticFinding[], check: CriticFinding["check"]) => findings.filter((f) => f.check === check);
const commandOf = (finding: CriticFinding, index = 0): Command => {
  const fix = finding.fixes[index];
  if (fix?.kind !== "command") throw new Error("no command fix");
  return fix.command;
};
const ctx = { generation: 0, sourceDurationsMs: { v1: 30000, v2: 30000, v3: 30000, v4: 30000 } };
/** A stock video clip: its own sound off, as the series reels have them. */
const video = (id: string, assetId: string, ms: number, over: Record<string, unknown> = {}) => ({ id, assetId, kind: "VIDEO", sourceStartMs: 0, sourceEndMs: ms, volume: 0, ...over });
const reel = (clips: unknown[], over: Record<string, unknown> = {}) => parseTimeline({ version: 1, clips, texts: [], music: null, ...over });

describe("reading time", () => {
  it("is words × 250 ms + 400 ms", () => {
    expect(readingTimeMs("Hello")).toBe(650);
    expect(readingTimeMs("Just listed in  Kyoto")).toBe(1400);
  });

  it("a title gone before it can be read is held longer (a safe fix); one held far past it is shortened (not safe)", () => {
    const timeline = reel([video("a", "v1", 6000)], { texts: [
      { id: "fast", text: "Three bed villa with a view", startMs: 500, endMs: 1200, y: 0.4 },
      { id: "long", text: "Hi", startMs: 1200, endMs: 6000, y: 0.5 },
    ] });
    const findings = ofCheck(run(timeline, { frames: framesFor(timeline, (s) => moving(s.sourceMs)) }), "reading");
    const fast = findings.find((f) => f.id === "reading-short:fast")!;
    expect(fast.severity).toBe("medium");
    expect(fast.impact).toBe("hook");
    expect(fast.reason).toBe("“Three bed villa with a …” is on screen 0.7 s; 6 words take about 1.9 s to read.");
    expect(commandOf(fast)).toEqual({ type: "updateText", textId: "fast", patch: { endMs: 500 + 1900 } });
    expect(fast.fixes[0]).toMatchObject({ safe: true });
    const fixed = applyCommand(timeline, commandOf(fast), ctx);
    expect(fixed.changes).toEqual([{ kind: "text", id: "fast" }]);
    expect(ofCheck(run(fixed.timeline), "reading").map((f) => f.id)).toEqual(["reading-long:long"]);
    const long = findings.find((f) => f.id === "reading-long:long")!;
    expect(long.severity).toBe("low");
    expect(long.fixes[0]).toMatchObject({ safe: false, command: { type: "updateText", textId: "long", patch: { endMs: 1200 + 1300 } } });
  });

  it("a tracked or counting title is never shortened; room labels are left to the editor", () => {
    const timeline = reel([video("a", "v1", 8000)], { texts: [
      { id: "pinned", text: "Hi", startMs: 0, endMs: 8000, pin: { assetId: "v1", fromMs: 0, toMs: 8000 }, path: [{ t: 0, x: 0, y: 0 }, { t: 1, x: 0.1, y: 0 }] },
      { id: "room-kitchen", text: "Kitchen", startMs: 0, endMs: 8000 },
    ] });
    expect(ofCheck(run(timeline), "reading")).toEqual([]);
  });
});

describe("dead air", () => {
  it("a still photo without a camera move is dead from the timeline alone, a cut or a title breaks it, speech keeps it alive", () => {
    const still = reel([{ id: "p", assetId: "p1", kind: "IMAGE", sourceStartMs: 0, sourceEndMs: 2000 }, video("a", "v1", 2000)]);
    const [finding] = ofCheck(retentionFindings({ timeline: still }), "dead-air");
    expect(finding.reason).toBe("Shot 1 holds still for 2.0 s with no cut, motion, speech or title.");
    expect(finding.fixes.map((f) => f.label)).toEqual(["Trim 1.0 s", "Slow push in"]);
    const titled = reel(still.clips, { texts: [{ id: "t", text: "Hi", startMs: 900, endMs: 1500 }] });
    expect(ofCheck(retentionFindings({ timeline: titled }), "dead-air")).toEqual([]);
  });

  it("a video is judged from its frames: a still 1.2 s is let go, 1.3 s is not, and no frames means no judgement", () => {
    const timeline = reel([video("a", "v1", 1300), video("b", "v2", 2000)]);
    const still = framesFor(timeline, (s) => (s.clipId === "a" ? picture(0.4) : moving(s.sourceMs)));
    expect(ofCheck(run(timeline, { frames: still }), "dead-air").map((f) => f.id)).toEqual(["dead-air:a:0"]);
    const short = reel([video("a", "v1", 1200), video("b", "v2", 2000)]);
    expect(ofCheck(run(short, { frames: framesFor(short, (s) => (s.clipId === "a" ? picture(0.4) : moving(s.sourceMs))) }), "dead-air")).toEqual([]);
    expect(ofCheck(run(timeline), "dead-air")).toEqual([]);
  });
});

describe("cut rate against the song", () => {
  const song = { assetId: "s", bpm: 120, beatOffsetMs: 0, sections: [{ kind: "intro", startMs: 0, endMs: 8000 }, { kind: "drop", startMs: 8000, endMs: 24000 }], downbeats: [0] };

  it("knows the pacing engine's bands", () => {
    expect(wantedShotBeats("drop", 0.5)).toBe(2);
    expect(wantedShotBeats("drop", 1)).toBe(1);
    expect(wantedShotBeats("intro", 0)).toBe(8);
    expect(wantedShotBeats("none", 0.5)).toBe(4);
  });

  it("shots in the drop twice as long as the song wants drag; the fix is the pacing command", () => {
    // 500 ms beats. Intro: two 4 s shots (8 beats each, wanted 8 at 0.5... fine). Drop: four 4 s shots (8 beats, wanted 2).
    // Ten drop shots: after the fix the reel is still longer than the 15 s a re-pace keeps.
    const clips = [video("i1", "v1", 4000), video("i2", "v2", 4000), ...Array.from({ length: 10 }, (_, i) => video(`d${i + 1}`, `v${(i % 4) + 1}`, 4000))];
    const timeline = reel(clips, { music: song });
    const [finding] = ofCheck(run(timeline), "cut-rate");
    expect(finding.severity).toBe("medium");
    expect(finding.reason).toBe("Shots in the drop run about 8 beats each; the song wants about 2 there, so the cut drags behind the music.");
    expect(commandOf(finding)).toEqual({ type: "pace", energy: 0.5 });
    const paced = applyCommand(timeline, commandOf(finding), ctx);
    expect(paced.rejected).toBeUndefined();
    expect(ofCheck(run(paced.timeline), "cut-rate")).toEqual([]);
  });

  it("says nothing without sections, and leaves spoken takes out of the count", () => {
    const clips = [video("i1", "v1", 4000), video("i2", "v2", 4000), video("d1", "v3", 4000), video("d2", "v4", 4000), video("d3", "v1", 4000)];
    expect(ofCheck(run(reel(clips, { music: { assetId: "s", bpm: 120, beatOffsetMs: 0 } })), "cut-rate")).toEqual([]);
    // Every drop shot speaks (and is held by pacing), so the drop's cut rate is the speech's, not the editor's.
    const words = [{ w: "hello", s: 0, e: 3900 }];
    const transcripts = { v3: { text: "hello", words }, v4: { text: "hello", words }, v1: { text: "hello", words } };
    const spoken = clips.map((clip) => ({ ...clip, volume: 1 }));
    expect(ofCheck(run(reel(spoken, { music: song }), { transcripts }), "cut-rate")).toEqual([]);
    // With the words unknown, every video playing its own sound is held, as the pacing engine holds it.
    expect(ofCheck(run(reel(spoken, { music: song })), "cut-rate")).toEqual([]);
  });
});

describe("the beat snap", () => {
  const song = { assetId: "s", bpm: 120, beatOffsetMs: 0 };

  it("moves off-beat cuts to frame-exact beats and keeps later cuts on their beats", () => {
    // Beats every 500 ms. Cuts at 1230, 2730 (both 230 ms late), 4000 (on the beat). Moving the first
    // cut back 230 ms puts the second on its beat, so only the third needs a trim to get back to 4000.
    const timeline = reel([video("a", "v1", 1230), video("b", "v2", 1500), video("c", "v3", 1270), video("d", "v4", 2000)], { music: song });
    const commands = frameExactSnap(timeline);
    expect(commands).toEqual([
      { type: "trimClip", clipId: "a", window: { sourceStartMs: 0, sourceEndMs: 1000 } },
      { type: "trimClip", clipId: "c", window: { sourceStartMs: 0, sourceEndMs: 1500 } },
    ]);
    const fixed = applyCommand(timeline, { type: "batch", commands }, ctx);
    const cuts = clipStartsMs(fixed.timeline).slice(1);
    expect(cuts).toEqual([1000, 2500, 4000]);
    expect(cuts.every(isFrameExact)).toBe(true);
    for (let i = 1; i < cuts.length; i++) expect(cuts[i] - cuts[i - 1]).toBeGreaterThanOrEqual(RETENTION.snapGapMs);
  });

  it("never lands within 60 ms of another cut, never shortens a clip under the minimum, never runs a video past its source", () => {
    // Cut at 1230 wants 1000, but a 30 ms photo flash ends at 1030: too close, so that cut stays.
    const crowded = reel([video("a", "v1", 1230), { id: "flash", assetId: "p1", kind: "IMAGE", sourceStartMs: 0, sourceEndMs: 600 }, video("c", "v3", 2000)], { music: song });
    const near = frameExactSnap(reel([video("a", "v1", 530), video("b", "v2", 700), video("c", "v3", 2000)], { music: song }));
    // Cuts at 530 and 1230: 530 wants 500, 1230 wants 1000; both fine, 500 ms apart.
    expect(near.map((c) => c.window.sourceEndMs)).toEqual([500, 500]);
    expect(frameExactSnap(crowded).map((c) => c.clipId)).toEqual(["a", "flash"]);
    // A clip that would fall under 500 ms is left: at 150 bpm (400 ms beats) the first cut moves to 1200,
    // which puts the 300 ms clip's cut at 1500 wanting 1600, a 400 ms clip.
    const tiny = reel([video("a", "v1", 1000), video("b", "v2", 300), video("c", "v3", 2000)], { music: { assetId: "s", bpm: 150, beatOffsetMs: 0 } });
    expect(frameExactSnap(tiny)).toEqual([{ type: "trimClip", clipId: "a", window: { sourceStartMs: 0, sourceEndMs: 1200 } }]);
    // A video whose source ends at 1100 cannot stretch to 1500.
    const short = reel([video("a", "v1", 1100, { sourceStartMs: 0 }), video("b", "v2", 2000)], { music: song });
    expect(frameExactSnap(short, { v1: 1100 })).toEqual([{ type: "trimClip", clipId: "a", window: { sourceStartMs: 0, sourceEndMs: 1000 } }]);
    const shortLate = reel([video("a", "v1", 1300), video("b", "v2", 2000)], { music: song });
    expect(frameExactSnap(shortLate, { v1: 1300 })).toEqual([]);
  });

  it("the old command is never offered and the fix is safe (Fix all applies it)", () => {
    const timeline = reel([video("a", "v1", 1230), video("b", "v2", 2000)], { music: song });
    const [finding] = ofCheck(run(timeline), "beat");
    expect(finding.fixes).toHaveLength(1);
    expect(finding.fixes[0]).toMatchObject({ safe: true, label: "Snap to the beat" });
    expect(JSON.stringify(finding)).not.toContain("snapToBeat");
  });
});

describe("the presenter", () => {
  it("over 6 s with no cutaway and nothing arriving opens the media sheet; a title arriving is enough", () => {
    const timeline = reel([video("take", "ai-maya-1", 8000), video("b", "v2", 2000)]);
    const [finding] = ofCheck(run(timeline), "presenter");
    expect(finding.reason).toBe("The presenter is on screen for 8.0 s in shot 1 with no cutaway and nothing arriving over her.");
    expect(finding.fixes).toEqual([{ kind: "open", label: "Drop a cutaway in", sheet: "media", clipId: "take" }]);
    const titled = reel(timeline.clips, { texts: [{ id: "t", text: "Hi", startMs: 3000, endMs: 5000 }] });
    expect(ofCheck(run(titled), "presenter")).toEqual([]);
    expect(ofCheck(run(reel([video("take", "ai-maya-1", 5000), video("b", "v2", 2000)])), "presenter")).toEqual([]);
    // A presenter named by id, not an AI asset.
    expect(ofCheck(run(reel([video("take", "v9", 8000)]), { presenterAssetIds: ["v9"] }), "presenter")).toHaveLength(1);
  });
});

describe("the opening", () => {
  it("an empty frame 0 is high; a title not readable by 300 ms gets a pop", () => {
    const timeline = reel([video("a", "v1", 3000)], { texts: [{ id: "t", text: "Welcome home", startMs: 100, endMs: 2500, style: "elegant", animation: "fade", y: 0.4 }] });
    const flat = { width: W, height: H, luma: new Float32Array(W * H).fill(0.5) };
    const findings = ofCheck(run(timeline, { frames: framesFor(timeline, (s) => (s.reelMs === 0 ? flat : moving(s.sourceMs))) }), "hook");
    expect(findings.map((f) => f.id)).toEqual(["opening:empty", "opening:title:t"]);
    expect(findings[0]).toMatchObject({ severity: "high", impact: "hook", fixes: [] });
    expect(findings[1].reason).toBe("“Welcome home” is only fully on screen at 0.70 s; the opening should read by 0.3 s.");
    expect(commandOf(findings[1])).toEqual({ type: "updateText", textId: "t", patch: { animation: "pop" } });
    const popped = applyCommand(timeline, commandOf(findings[1]), ctx);
    expect(ofCheck(run(popped.timeline, { frames: framesFor(popped.timeline, (s) => moving(s.sourceMs)) }), "hook")).toEqual([]);
  });

  it("a pop that starts too late is started earlier, so it is in by 300 ms; one in time is left alone", () => {
    const late = reel([video("a", "v1", 3000)], { texts: [{ id: "t", text: "Welcome home", startMs: 250, endMs: 2500, y: 0.4 }] });
    const findings = ofCheck(run(late), "hook");
    expect(findings.map((f) => f.id)).toEqual(["opening:title:t"]);
    expect(findings[0].reason).toBe("“Welcome home” is only fully on screen at 0.40 s; the opening should read by 0.3 s.");
    expect(findings[0].fixes[0]).toMatchObject({ label: "Start it at 0.15 s", safe: false });
    expect(commandOf(findings[0])).toEqual({ type: "updateText", textId: "t", patch: { startMs: 150 } });
    const earlier = applyCommand(late, commandOf(findings[0]), ctx);
    expect(ofCheck(run(earlier.timeline), "hook")).toEqual([]);
    const inTime = reel([video("a", "v1", 3000)], { texts: [{ id: "t", text: "Welcome home", startMs: 100, endMs: 2500, y: 0.4 }] });
    expect(ofCheck(run(inTime), "hook")).toEqual([]);
  });

  it("the hook planner's facts win when given", () => {
    const timeline = reel([video("a", "v1", 3000)], { texts: [{ id: "t", text: "Welcome home", startMs: 100, endMs: 2500, style: "elegant", y: 0.4 }] });
    expect(ofCheck(run(timeline, { hook: { openingEmpty: false, titleLegibleByMs: 200 } }), "hook")).toEqual([]);
    expect(ofCheck(run(timeline, { hook: { openingEmpty: true } }), "hook").map((f) => f.id)).toEqual(["opening:empty", "opening:title:t"]);
  });
});

describe("untouched stock", () => {
  it("scores how much a clip was changed, and a measured score replaces the guess", () => {
    const plain = reel([video("a", "v1", 3000)]);
    expect(transformScoreOf(plain.clips[0], plain, 0)).toBe(0);
    const moved = reel([video("a", "v1", 3000, { motion: "zoom-in", filter: "warm" })]);
    expect(transformScoreOf(moved.clips[0], moved, 0)).toBeCloseTo(0.55);
    const [finding] = ofCheck(run(plain), "stock");
    expect(finding).toMatchObject({ severity: "low", reason: "Shot 1 plays exactly as the file came: no move, zoom, grade, speed or title makes it yours." });
    expect(commandOf(finding)).toEqual({ type: "updateClip", clipId: "a", patch: { motion: "zoom-in" } });
    expect(ofCheck(run(applyCommand(plain, commandOf(finding), ctx).timeline), "stock")).toEqual([]);
    expect(ofCheck(run(plain, { transformScores: { v1: 0.6 } }), "stock")).toEqual([]);
    expect(ofCheck(run(moved, { transformScores: { v1: 0.1 } }), "stock")).toHaveLength(1);
    // A title over it, a flash of under 1.5 s, or a presenter take needs no move.
    expect(ofCheck(run(reel(plain.clips, { texts: [{ id: "t", text: "Hi", startMs: 0, endMs: 1000 }] })), "stock")).toEqual([]);
    expect(ofCheck(run(reel([video("a", "v1", 1200)])), "stock")).toEqual([]);
    expect(ofCheck(run(reel([video("a", "ai-take", 3000)])), "stock")).toEqual([]);
  });
});

describe("the old false positives", () => {
  it("a boxed or tag title never gets a shadow finding, whatever its shadow setting and whatever is behind it", () => {
    for (const style of ["box", "tag"]) {
      for (const shadow of [undefined, "none", "soft", "auto"]) {
        const timeline = reel([video("a", "v1", 3000)], { texts: [{ id: "t", text: "If house listings were honest", startMs: 0, endMs: 2500, style, y: 0.4, color: "#ffffff", ...(shadow ? { shadow } : {}) }] });
        const bright = framesFor(timeline, () => picture(0.95));
        const findings = run(timeline, { frames: bright });
        expect(findings.filter((f) => f.id === "legibility:t")).toEqual([]);
        expect(JSON.stringify(findings)).not.toContain("Add a shadow");
      }
    }
    // A plain white title on a white wall still gets one.
    const plain = reel([video("a", "v1", 3000)], { texts: [{ id: "t", text: "If house listings were honest", startMs: 0, endMs: 2500, y: 0.4, color: "#ffffff" }] });
    expect(run(plain, { frames: framesFor(plain, () => picture(0.95)) }).filter((f) => f.id === "legibility:t")).toHaveLength(1);
  });

  it("every cut the snap proposes is on the frame grid and clear of other cuts, so it cannot bring back the renderer's black frame", () => {
    const song = { assetId: "s", bpm: 119, beatOffsetMs: 40 };
    const clips = [video("a", "v1", 3025), video("b", "v2", 1480), video("c", "v3", 2510), video("d", "v4", 1990), video("e", "v1", 3000)];
    const timeline = reel(clips, { music: song });
    const [finding] = ofCheck(run(timeline), "beat");
    const fixed = applyCommand(timeline, commandOf(finding), ctx);
    expect(fixed.rejected).toBeUndefined();
    const cuts = clipStartsMs(fixed.timeline).slice(1);
    expect(cuts.every(isFrameExact)).toBe(true);
    for (const cut of cuts) expect(cuts.filter((other) => other !== cut && Math.abs(other - cut) < RETENTION.snapGapMs)).toEqual([]);
  });
});

describe("series from the editor's samples", () => {
  it("lists frames by reel time, including each clip's last frame", () => {
    const timeline = reel([video("a", "v1", 1300), video("b", "v2", 1000)]);
    const series = seriesFromSamples(timeline, framesFor(timeline, (s) => moving(s.sourceMs)));
    // The half-second grid, the opening's 1.5 s, each clip's first and last frames and the loop end's frame.
    expect(series.map((f) => f.ms)).toEqual([0, 500, 1000, 1267, 1300, 1500, 1767, 1800, 2267]);
  });
});
