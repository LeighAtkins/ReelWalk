import { describe, expect, it, vi } from "vitest";
import { applyCommand, diffTimelines, type Command } from "../src/commands";
import {
  CRITIC,
  criticFaceFromGeneration,
  criticSamples,
  critique,
  fixAllCommand,
  frameDifference,
  colorLuminance as colorLuminanceOf,
  invertedInkLuminance,
  lumaFromRgba,
  settleUndecided,
  type CriticFace,
  type CriticFinding,
  type CriticFrame,
  type CriticInput,
  type CriticSample,
} from "../src/critic";
import { MIN_GATE_FACE_PX, MIN_SPEAKING_FACE_PX } from "../src/presenter";
import type { Measure, TitleFont } from "../src/scene";
import { parseTimeline, ROOM_LABEL_AT, timelineDurationMs, type TextOverlay, type Timeline } from "../src/timeline";

// The critic before export (ADR 0062): each check on a fixture reel, each fix as the command it should be,
// and no fix touching anything outside its scope.

const STYLE_SCALE: Record<string, number> = { headline: 1.3, elegant: 0.78, tag: 0.7 };
const titleFont = (text: TextOverlay): TitleFont => ({ fontSize: 76 * text.size * (STYLE_SCALE[text.style] ?? 1) });
const measure: Measure = (line, font) => ({ width: line.length * font.fontSize * 0.55, height: font.fontSize * 1.12 });

/** A still frame of one luma with a faint fixed grain (a real wall is never one flat colour; a flat frame 0 reads as empty). */
const flat = (luma: number, width = 18, height = 32): CriticFrame => {
  const frame = { width, height, luma: new Float32Array(width * height) };
  frame.luma.forEach((_, i) => { frame.luma[i] = Math.min(1, Math.max(0, luma + 0.03 * Math.sin(i * 0.9))); });
  return frame;
};
/** A frame whose top half is `top` and bottom half `bottom`. */
const split = (top: number, bottom: number): CriticFrame => {
  const frame = flat(0);
  frame.luma.forEach((_, i) => { frame.luma[i] = i < frame.luma.length / 2 ? top : bottom; });
  return frame;
};
/** A textured frame that shifts with time: consecutive reads 500 ms apart differ well above the motion threshold. */
const moving = (ms: number): CriticFrame => {
  const frame = flat(0);
  frame.luma.forEach((_, i) => { frame.luma[i] = 0.5 + 0.4 * Math.sin(i * 0.7 + ms / 90); });
  return frame;
};

/** Frames for every moment the critic asks for, drawn by `paint(sample)`. */
function framesFor(timeline: Timeline, paint: (sample: CriticSample) => CriticFrame | null): Map<string, CriticFrame> {
  const frames = new Map<string, CriticFrame>();
  for (const sample of criticSamples(timeline)) {
    const frame = paint(sample);
    if (frame) frames.set(sample.key, frame);
  }
  return frames;
}

const run = (timeline: Timeline, extra: Partial<CriticInput> = {}) => critique({ timeline, titleFont, measure, ...extra });
const ofCheck = (findings: CriticFinding[], check: CriticFinding["check"]) => findings.filter((f) => f.check === check);
const commandOf = (finding: CriticFinding, index = 0): Command => {
  const fix = finding.fixes[index];
  if (fix?.kind !== "command") throw new Error("no command fix");
  return fix.command;
};
const ctx = { generation: 0, sourceDurationsMs: { v1: 20000, v2: 20000, v3: 20000 } };

function reel(overrides: Record<string, unknown> = {}): Timeline {
  return parseTimeline({
    version: 1,
    clips: [
      { id: "a", assetId: "v1", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 1200 },
      { id: "b", assetId: "v2", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 1800 },
      { id: "c", assetId: "v3", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 1500 },
    ],
    texts: [],
    music: null,
    ...overrides,
  });
}

describe("hook", () => {
  const stillOpening = (texts: unknown[] = []) => reel({
    clips: [
      { id: "still", assetId: "v1", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 1900 },
      { id: "walk", assetId: "v2", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 1800 },
      { id: "pool", assetId: "v3", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 1500 },
    ],
    texts,
  });
  const paint = (sample: CriticSample) => (sample.clipId === "walk" ? moving(sample.sourceMs) : flat(0.4));

  it("a still opening with no cut or title is flagged, with the liveliest shot and a title as fixes", () => {
    const timeline = stillOpening();
    const [hook] = ofCheck(run(timeline, { frames: framesFor(timeline, paint), headline: "Villa Serena" }), "hook");
    expect(hook.severity).toBe("high");
    expect(commandOf(hook, 0)).toEqual({ type: "moveClip", clipId: "walk", toIndex: 0 });
    expect(commandOf(hook, 1)).toMatchObject({ type: "addText", text: { id: "hook-title", text: "Villa Serena", startMs: 150 } });
    // The reorder changes the order and nothing else.
    const moved = applyCommand(timeline, commandOf(hook, 0), ctx);
    expect(moved.changes.every((change) => change.kind === "clip")).toBe(true);
    expect(moved.timeline.clips.map((clip) => clip.id)).toEqual(["walk", "still", "pool"]);
    // After the fix the opening moves, so there is nothing to say.
    expect(ofCheck(run(moved.timeline, { frames: framesFor(moved.timeline, paint) }), "hook")).toEqual([]);
    // The title fix adds one text and changes nothing else.
    const titled = applyCommand(timeline, commandOf(hook, 1), ctx);
    expect(titled.changes).toEqual([{ kind: "text", id: "hook-title" }]);
    expect(ofCheck(run(titled.timeline, { frames: framesFor(titled.timeline, paint) }), "hook")).toEqual([]);
  });

  it("a cut, a title, a hook or a camera move in the first 1.5 s is enough", () => {
    const frames = (t: Timeline) => framesFor(t, paint);
    expect(ofCheck(run(reel(), { frames: frames(reel()) }), "hook")).toEqual([]); // cut at 1.2 s
    const titled = stillOpening([{ id: "t", text: "Just listed", startMs: 600, endMs: 2000 }]);
    expect(ofCheck(run(titled, { frames: frames(titled) }), "hook")).toEqual([]);
    const hooked = { ...stillOpening(), hook: { kind: "alert", text: "New", font: "sans" } } as unknown as Timeline;
    expect(ofCheck(run(parseTimeline(hooked), { frames: frames(stillOpening()) }), "hook")).toEqual([]);
    const zooming = parseTimeline({ ...stillOpening(), clips: stillOpening().clips.map((clip, i) => (i === 0 ? { ...clip, motion: "zoom-in" } : clip)) });
    expect(ofCheck(run(zooming, { frames: frames(zooming) }), "hook")).toEqual([]);
  });

  it("a video opening is judged only from its pixels: moving footage passes, unread footage is not guessed", () => {
    const timeline = stillOpening();
    expect(ofCheck(run(timeline, { frames: framesFor(timeline, (s) => moving(s.sourceMs)) }), "hook")).toEqual([]);
    expect(ofCheck(run(timeline), "hook")).toEqual([]);
  });

  it("a still photo opening needs no pixels to be flagged; without a livelier shot or a name there is no fix to offer", () => {
    const timeline = reel({ clips: [{ id: "p", assetId: "p1", kind: "IMAGE", sourceStartMs: 0, sourceEndMs: 4000 }] });
    const [hook] = ofCheck(run(timeline), "hook");
    expect(hook.fixes).toEqual([]);
  });
});

describe("safe zones", () => {
  const titled = (text: Record<string, unknown>) => reel({ texts: [{ id: "t", text: "Open Saturday", startMs: 500, endMs: 3000, ...text }] });

  it("a title in the header or under the caption is moved inside the safe area, and only that title changes", () => {
    for (const y of [0.06, 0.9]) {
      const timeline = titled({ y });
      const [finding] = ofCheck(run(timeline), "safe-zone");
      expect(finding.severity).toBe("high");
      expect(finding.reason).toMatch(y < 0.5 ? /header/ : /caption/);
      const command = commandOf(finding);
      expect(command).toMatchObject({ type: "updateText", textId: "t" });
      const fixed = applyCommand(timeline, command, ctx);
      expect(fixed.changes).toEqual([{ kind: "text", id: "t" }]);
      const before = timeline.texts[0], after = fixed.timeline.texts[0];
      expect({ ...after, x: before.x, y: before.y }).toEqual(before);
      expect(ofCheck(run(fixed.timeline), "safe-zone")).toEqual([]);
    }
  });

  it("a caption wider than the safe area is centred in it, which clears the buttons", () => {
    const timeline = titled({ text: "A bright open kitchen with room for everyone to gather round", y: 0.5 });
    const [finding] = ofCheck(run(timeline), "safe-zone");
    expect(finding.reason).toMatch(/like and share/);
    const fixed = applyCommand(timeline, commandOf(finding), ctx).timeline;
    expect(fixed.texts[0].x).toBeCloseTo((60 + 960) / 2 / 1080, 2);
    expect(ofCheck(run(fixed), "safe-zone")).toEqual([]);
  });

  it("a title on a surface is reported without a move (its corners decide where it is); room labels are left to the editor", () => {
    const surface = titled({ surface: [0.1, 0.02, 0.9, 0.02, 0.9, 0.1, 0.1, 0.1] });
    const [finding] = ofCheck(run(surface), "safe-zone");
    expect(finding.fixes).toEqual([]);
    expect(finding.reason).toMatch(/corners/);
    const labelled = reel({ texts: [{ id: "room-a", text: "Kitchen", startMs: 200, endMs: 1100, y: 0.95, style: "box" }] });
    expect(run(labelled).filter((f) => f.textId === "room-a")).toEqual([]);
  });

  it("a tracked title is never moved by x/y (its path is offsets from them), so Fix all leaves it alone", () => {
    const pinned = titled({ y: 0.08, pin: { assetId: "v1", fromMs: 0, toMs: 1200 }, path: [{ t: 0, x: 0, y: 0 }, { t: 1, x: 0.05, y: 0.01 }] });
    const [finding] = ofCheck(run(pinned), "safe-zone");
    expect(finding.fixes).toEqual([]);
    expect(finding.reason).toMatch(/tracked/);
    expect(fixAllCommand(run(pinned))).toBeNull();
  });

  it("a title well inside is not flagged", () => {
    expect(ofCheck(run(titled({ y: 0.4 })), "safe-zone")).toEqual([]);
  });

  it("a title the app placed is left alone, and is the person's to fix once they move it (ADR 0081)", () => {
    expect(ofCheck(run(titled({ y: 0.9, byApp: true })), "safe-zone")).toEqual([]);
    expect(ofCheck(run(titled({ y: 0.9 })), "safe-zone")).toHaveLength(1);
  });

  it("where the app draws a room label is clear of Instagram's zones, measured as the critic measures a title", () => {
    const label = titled({ id: "label", text: "Living room", ...ROOM_LABEL_AT, style: "box", size: 0.8 });
    expect(ofCheck(run(label), "safe-zone")).toEqual([]);
    // The first version's spot was on the caption line and would have been flagged.
    expect(ofCheck(run(titled({ id: "label", text: "Living room", x: 0.5, y: 0.74, style: "box", size: 0.8 })), "safe-zone")).toHaveLength(1);
  });
});

describe("dead air", () => {
  it("a still photo held over 1.2 s is trimmed to 1 s or given a push in; one with a camera move is not dead", () => {
    const timeline = reel({ clips: [...reel().clips, { id: "p", assetId: "p1", kind: "IMAGE", sourceStartMs: 0, sourceEndMs: 5000 }] });
    const [finding] = ofCheck(run(timeline), "dead-air");
    expect(finding.severity).toBe("medium");
    expect(finding.impact).toBe("hold");
    expect(commandOf(finding)).toEqual({ type: "trimClip", clipId: "p", window: { sourceStartMs: 0, sourceEndMs: 1000 } });
    expect(commandOf(finding, 1)).toEqual({ type: "updateClip", clipId: "p", patch: { motion: "zoom-in" } });
    expect(ofCheck(run(applyCommand(timeline, commandOf(finding, 1), ctx).timeline), "dead-air")).toEqual([]);
    const fixed = applyCommand(timeline, commandOf(finding), ctx);
    expect(fixed.changes).toEqual([{ kind: "clip", id: "p" }]);
    expect(ofCheck(run(fixed.timeline), "dead-air")).toEqual([]);
    const moving = parseTimeline({ ...timeline, clips: timeline.clips.map((clip) => (clip.id === "p" ? { ...clip, motion: "zoom-in" } : clip)) });
    expect(ofCheck(run(moving), "dead-air")).toEqual([]);
  });

  it("a video that stops moving at its end is trimmed there; one still in the middle is sped up", () => {
    const clips = [{ id: "v", assetId: "v1", kind: "VIDEO", sourceStartMs: 1000, sourceEndMs: 7000 }, ...reel().clips];
    const timeline = reel({ clips });
    // Moving for the first 2 s of the shot (source 1000–3000), then still to its end.
    const tailStill = framesFor(timeline, (s) => (s.clipId === "v" && s.sourceMs >= 3000 ? flat(0.3) : moving(s.sourceMs)));
    const [end] = ofCheck(run(timeline, { frames: tailStill }), "dead-air");
    expect(commandOf(end)).toEqual({ type: "trimClip", clipId: "v", window: { sourceStartMs: 1000, sourceEndMs: 4000 } });
    expect(applyCommand(timeline, commandOf(end), ctx).changes.filter((c) => c.kind === "clip")).toEqual([{ kind: "clip", id: "v" }]);

    // Still from 1.5 s to 4.5 s into the shot, moving either side: 2× would leave 1.5 s of stillness, 3× brings it under 1.2 s.
    const midStill = framesFor(timeline, (s) => (s.clipId === "v" && s.sourceMs >= 2500 && s.sourceMs <= 5500 ? flat(0.3) : moving(s.sourceMs)));
    const [middle] = ofCheck(run(timeline, { frames: midStill }), "dead-air");
    expect(commandOf(middle)).toEqual({ type: "setSpeed", clipId: "v", speed: 3 });
  });

  it("a title starting or ending breaks the stillness; unread video is not judged", () => {
    const clips = [{ id: "v", assetId: "v1", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 3000 }, ...reel().clips];
    const timeline = reel({ clips, texts: [{ id: "t", text: "Kitchen", startMs: 1000, endMs: 2000, y: 0.4 }] });
    const paint = (s: CriticSample) => (s.clipId === "v" ? flat(0.3) : moving(s.sourceMs));
    // Still all through, but the title arrives at 1 s and leaves at 2 s: no stretch over 1.2 s.
    expect(ofCheck(run(timeline, { frames: framesFor(timeline, paint) }), "dead-air")).toEqual([]);
    expect(ofCheck(run(reel({ clips })), "dead-air")).toEqual([]);
    const [still] = ofCheck(run(reel({ clips }), { frames: framesFor(reel({ clips }), paint) }), "dead-air");
    expect(still.reason).toBe("Shot 1 holds still for 3.0 s with no cut, motion, speech or title.");
  });

  it("speech keeps a still shot alive", () => {
    const clips = [{ id: "v", assetId: "v1", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 3000, volume: 1 }, ...reel().clips];
    const timeline = reel({ clips });
    const frames = framesFor(timeline, (s) => (s.clipId === "v" ? flat(0.3) : moving(s.sourceMs)));
    const words = [{ w: "welcome", s: 200, e: 900 }, { w: "to", s: 900, e: 1100 }, { w: "the", s: 1100, e: 1300 }, { w: "villa", s: 1300, e: 2200 }];
    expect(ofCheck(run(timeline, { frames, transcripts: { v1: { text: "welcome to the villa", words } } }), "dead-air")).toEqual([]);
    // The same words with the sound off are not heard.
    const muted = reel({ clips: clips.map((clip) => (clip.id === "v" ? { ...clip, volume: 0 } : clip)) });
    expect(ofCheck(run(muted, { frames: framesFor(muted, (s) => (s.clipId === "v" ? flat(0.3) : moving(s.sourceMs))), transcripts: { v1: { text: "welcome to the villa", words } } }), "dead-air")).toHaveLength(1);
  });
});

describe("faces", () => {
  const ai = reel({ clips: [{ id: "say", assetId: "ai1", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 4000 }, ...reel().clips] });
  const face = (patch: Partial<CriticFace>): CriticFace => ({ assetId: "ai1", floorPx: MIN_SPEAKING_FACE_PX, faceHeightPx: 150, identityScore: 0.9, eyesAndMouthRendered: true, ...patch });

  it("a face under the gate's own floor is flagged high, with a new take offered (never a timeline change)", () => {
    const [finding] = ofCheck(run(ai, { faces: [face({})] }), "face");
    expect(finding.severity).toBe("high");
    expect(finding.reason).toMatch(/150 px.*165 px/);
    expect(finding.fixes).toEqual([{ kind: "open", label: "Make a closer take", sheet: "ai-video", clipId: "say" }]);
    expect(fixAllCommand([finding])).toBeNull();
  });

  it("between the speaking floor and 220 px it is low advice with no credit-spending fix", () => {
    const [advice] = ofCheck(run(ai, { faces: [face({ faceHeightPx: 190 })] }), "face");
    expect(advice).toMatchObject({ severity: "low", fixes: [] });
    expect(advice.reason).toMatch(/190 px/);
    expect(ofCheck(run(ai, { faces: [face({ faceHeightPx: 230 })] }), "face")).toEqual([]);
  });

  it("the clip's zoom counts; a silent take is held only to the gate's floor for it; a borderline identity score is flagged", () => {
    const zoomed = parseTimeline({ ...ai, clips: ai.clips.map((clip, i) => (i === 0 ? { ...clip, zoom: 1.5 } : clip)) });
    expect(ofCheck(run(zoomed, { faces: [face({})] }), "face")).toEqual([]);
    expect(ofCheck(run(ai, { faces: [face({ floorPx: MIN_GATE_FACE_PX })] }), "face")).toEqual([]);
    expect(ofCheck(run(ai, { faces: [face({ floorPx: MIN_GATE_FACE_PX, faceHeightPx: 100 })] }), "face")[0]).toMatchObject({ severity: "high" });
    expect(ofCheck(run(ai, { faces: [face({ floorPx: null })] }), "face")).toEqual([]);
    const [borderline] = ofCheck(run(ai, { faces: [face({ faceHeightPx: 300, identityScore: 0.64 })] }), "face");
    expect(borderline.severity).toBe("medium");
    expect(borderline.reason).toMatch(/0\.64/);
    const [features] = ofCheck(run(ai, { faces: [face({ faceHeightPx: 300, eyesAndMouthRendered: false })] }), "face");
    expect(features).toMatchObject({ id: "face-features:say", severity: "high" });
  });

  it("reads the accepted attempt of each composed end from the gate's checks (ADR 0056)", () => {
    const row = {
      assetId: "ai1", identityScore: 0.82, shot: { prompt: "x", line: "Welcome home" },
      identityChecks: [
        { end: "first", attempt: 1, samePerson: false, confidence: 0, faceHeightPx: 90, reason: "face-too-small" },
        { end: "first", attempt: 2, samePerson: true, confidence: 0.82, faceHeightPx: 260, minFacePx: 165, eyesAndMouthRendered: true },
        { end: "last", attempt: 1, samePerson: true, confidence: 0.9, faceHeightPx: 240, minFacePx: 165, eyesAndMouthRendered: true },
      ],
    };
    expect(criticFaceFromGeneration(row)).toEqual({ assetId: "ai1", floorPx: 165, faceHeightPx: 240, identityScore: 0.82, eyesAndMouthRendered: true });
    // The floor is what the gate recorded, not re-derived from the shot: a line the gate held to 120 stays at 120.
    const recorded = { ...row, identityChecks: row.identityChecks.map((check) => ({ ...check, minFacePx: 120 })) };
    expect(criticFaceFromGeneration(recorded).floorPx).toBe(MIN_GATE_FACE_PX);
    // An accepted end without eyes and mouth (a take from before the gate required them) is flagged; a row the gate never saw is unknown.
    const smeared = { ...row, identityChecks: [{ end: "first", attempt: 1, samePerson: true, confidence: 0.8, faceHeightPx: 250, eyesAndMouthRendered: false }] };
    expect(criticFaceFromGeneration(smeared).eyesAndMouthRendered).toBe(false);
    // Checks from before the gate recorded its floor: a spoken line means the speaking floor.
    expect(criticFaceFromGeneration(smeared).floorPx).toBe(MIN_SPEAKING_FACE_PX);
    expect(criticFaceFromGeneration({ assetId: "x", shot: null, identityChecks: null, identityScore: null })).toEqual({ assetId: "x", floorPx: null, faceHeightPx: null, identityScore: null, eyesAndMouthRendered: null });
  });
});

describe("legibility", () => {
  // A title over the top half of the frame (y 0.3): the frame's top half is what is behind it.
  const titled = (text: Record<string, unknown>) => reel({ clips: [{ id: "a", assetId: "v1", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 4000 }], texts: [{ id: "t", text: "Sea views", startMs: 500, endMs: 3000, y: 0.3, ...text }] });
  const over = (timeline: Timeline, frame: CriticFrame) => framesFor(timeline, () => frame);

  it("white type on a bright picture gets a strong shadow, and only that title's shadow changes", () => {
    const timeline = titled({});
    const [finding] = ofCheck(run(timeline, { frames: over(timeline, flat(0.95)) }), "legibility");
    expect(finding.severity).toBe("high");
    expect(commandOf(finding)).toEqual({ type: "updateText", textId: "t", patch: { shadow: "strong" } });
    const fixed = applyCommand(timeline, commandOf(finding), ctx);
    expect(fixed.changes).toEqual([{ kind: "text", id: "t" }]);
    expect({ ...fixed.timeline.texts[0], shadow: undefined }).toEqual({ ...timeline.texts[0], shadow: undefined });
    expect(ofCheck(run(fixed.timeline, { frames: over(fixed.timeline, flat(0.95)) }), "legibility")).toEqual([]);
  });

  it("white type on a dark picture, a label style, and dark type on a bright picture are fine", () => {
    const timeline = titled({});
    expect(ofCheck(run(timeline, { frames: over(timeline, flat(0.1)) }), "legibility")).toEqual([]);
    const label = titled({ style: "box" });
    expect(ofCheck(run(label, { frames: over(label, flat(0.95)) }), "legibility")).toEqual([]);
    const dark = titled({ color: "#111111" });
    expect(ofCheck(run(dark, { frames: over(dark, flat(0.95)) }), "legibility")).toEqual([]);
  });

  it("painted on a surface, the fix is to stop painting it", () => {
    const timeline = titled({ blend: "surface", shadow: "strong" });
    const [finding] = ofCheck(run(timeline, { frames: over(timeline, flat(0.95)) }), "legibility");
    expect(commandOf(finding)).toEqual({ type: "updateText", textId: "t", patch: { blend: "plain" } });
  });

  it("inverted (ADR 0091): fine on a dark or a bright picture, lost on a mid-tone, and the fix is to stop inverting", () => {
    const inverted = titled({ blend: "invert" });
    expect(ofCheck(run(inverted, { frames: over(inverted, flat(0.95)) }), "legibility")).toEqual([]);
    expect(ofCheck(run(inverted, { frames: over(inverted, flat(0.08)) }), "legibility")).toEqual([]);
    // A plain white title over the same bright window is flagged; inverted it is the window's negative, near black.
    expect(ofCheck(run(titled({}), { frames: over(titled({}), flat(0.95)) }), "legibility")).toHaveLength(1);
    const [finding] = ofCheck(run(inverted, { frames: over(inverted, flat(0.5)) }), "legibility");
    expect(finding.severity).toBe("high");
    expect(finding.fixes[0]).toMatchObject({ label: "On top, not inverted", command: { type: "updateText", textId: "t", patch: { blend: "plain" } } });
    // Drawn without them, a strong shadow, an outline or a box does not exempt an inverted title on a mid-tone.
    for (const extra of [{ shadow: "strong" }, { style: "outline" }, { style: "box" }, { depth: "extruded" }]) {
      const treated = titled({ blend: "invert", ...extra });
      expect(ofCheck(run(treated, { frames: over(treated, flat(0.5)) }), "legibility"), JSON.stringify(extra)).toHaveLength(1);
    }
  });

  it("inverted across a dark wall and a bright window is fine: no mid-tone is invented from their mean", () => {
    const split: CriticFrame = { width: 18, height: 32, luma: new Float32Array(18 * 32) };
    split.luma.forEach((_, i) => { split.luma[i] = i % 18 < 11 ? 0.06 : 0.94; });
    const inverted = titled({ blend: "invert" });
    expect(ofCheck(run(inverted, { frames: over(inverted, split) }), "legibility")).toEqual([]);
  });

  it("an inverted title's ink is the picture's negative times its colour", () => {
    expect(invertedInkLuminance(0, "#ffffff")).toBeCloseTo(1, 5);
    expect(invertedInkLuminance(1, "#ffffff")).toBeCloseTo(0, 5);
    // sRGB mid-grey (0.5 encoded, 0.214 linear) inverts to itself.
    expect(invertedInkLuminance(0.214, "#ffffff")).toBeCloseTo(0.214, 2);
    // Tinted: a dark picture under pale yellow letters gives pale yellow, never brighter than the tint.
    expect(invertedInkLuminance(0, "#f2ef9c")).toBeCloseTo(colorLuminanceOf("#f2ef9c"), 5);
  });

  it("small type on a phone is made bigger", () => {
    const timeline = titled({ style: "elegant", size: 0.3 });
    const [finding] = run(timeline).filter((f) => f.id === "legibility-size:t");
    const command = commandOf(finding);
    expect(command).toMatchObject({ type: "updateText", textId: "t" });
    const size = (command as { patch: { size: number } }).patch.size;
    expect(76 * 0.78 * size * (412 / 1080)).toBeGreaterThanOrEqual(CRITIC.minPhoneFontPx);
    expect(run(applyCommand(timeline, command, ctx).timeline).filter((f) => f.id === "legibility-size:t")).toEqual([]);
  });

  it("a busy background the pixels cannot call is asked of the judge once; nothing else is sent", async () => {
    const timeline = titled({});
    // Mostly dark behind the words, with a bright band: the mean reads, the brightest tenth does not.
    const frame = flat(0.15);
    frame.luma.forEach((_, i) => { if (i % 6 === 0) frame.luma[i] = 0.98; });
    const frames = over(timeline, frame);
    const findings = run(timeline, { frames });
    const [open] = ofCheck(findings, "legibility");
    expect(open.undecided).toBeTruthy();
    expect(open.severity).toBe("low");
    const readable = vi.fn(async () => ({ readable: true }));
    expect(ofCheck(await settleUndecided(findings, readable, timeline, frames), "legibility")).toEqual([]);
    expect(readable).toHaveBeenCalledTimes(1);
    expect(readable.mock.calls[0]).toEqual([expect.objectContaining({ textId: "t", text: "Sea views", frame })]);
    const unreadable = vi.fn(async () => ({ readable: false }));
    const [kept] = ofCheck(await settleUndecided(findings, unreadable, timeline, frames), "legibility");
    expect(kept.severity).toBe("medium");
    // A decided finding never reaches the judge.
    const decided = run(timeline, { frames: over(timeline, flat(0.95)) });
    const judge = vi.fn(async () => ({ readable: true }));
    expect(await settleUndecided(decided, judge, timeline)).toEqual(decided);
    expect(judge).not.toHaveBeenCalled();
  });
});

describe("loop", () => {
  const long = (music: unknown = null) => reel({
    clips: [
      { id: "a", assetId: "v1", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 2000 },
      { id: "z", assetId: "v2", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 5000 },
    ],
    music,
  });

  it("an ending unlike the opening is cut back to the frame most like it", () => {
    const timeline = long();
    // The last shot pans away from a view like the opening: at 2.5 s into it, it matches.
    const frames = framesFor(timeline, (s) => (s.clipId === "a" ? flat(0.2) : flat(Math.abs(s.sourceMs - 2500) < 300 ? 0.22 : 0.8)));
    const [finding] = ofCheck(run(timeline, { frames }), "loop");
    expect(finding.reason).toMatch(/jumps/);
    expect(commandOf(finding)).toEqual({ type: "trimClip", clipId: "z", window: { sourceStartMs: 0, sourceEndMs: 2500 } });
    expect(applyCommand(timeline, commandOf(finding), ctx).changes).toEqual([{ kind: "clip", id: "z" }]);
  });

  it("with a tempo the reel ends on a bar", () => {
    // 120 bpm: a bar is 2 s. The reel is 7 s, so it stops half way through the fourth bar.
    const timeline = long({ assetId: "song", bpm: 120, beatOffsetMs: 0 });
    const frames = framesFor(timeline, () => flat(0.4));
    const [finding] = ofCheck(run(timeline, { frames }), "loop");
    expect(finding.reason).toMatch(/mid-bar/);
    const fixed = applyCommand(timeline, commandOf(finding), ctx);
    expect(timelineDurationMs(fixed.timeline)).toBe(6000);
    expect(fixed.changes).toEqual([{ kind: "clip", id: "z" }]);
    expect(ofCheck(run(fixed.timeline, { frames: framesFor(fixed.timeline, () => flat(0.4)) }), "loop")).toEqual([]);
  });

  it("matching ends on a bar say nothing", () => {
    const timeline = long({ assetId: "song", bpm: 120, beatOffsetMs: 1000 });
    expect(ofCheck(run(timeline, { frames: framesFor(timeline, () => flat(0.4)) }), "loop")).toEqual([]);
  });
});

describe("beat", () => {
  const withSong = (cutMs: number) => reel({
    clips: [
      { id: "a", assetId: "v1", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: cutMs },
      { id: "b", assetId: "v2", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 4000 },
    ],
    texts: [{ id: "cap", text: "Just listed", startMs: 200, endMs: 5000, y: 0.4 }],
    music: { assetId: "song", bpm: 120, beatOffsetMs: 0 },
  });

  it("cuts between beats are snapped by frame-exact trims, never by the old snap; on-beat cuts say nothing", () => {
    expect(ofCheck(run(withSong(3000)), "beat")).toEqual([]);
    const timeline = withSong(3250);
    const [finding] = ofCheck(run(timeline), "beat");
    expect(finding.reason).toBe("1 of 1 cuts land between beats of the song.");
    // 3250 is as near 3000 as 3500; the nearest-beat rule rounds up, and 3500 is on the frame grid.
    expect(commandOf(finding)).toEqual({ type: "trimClip", clipId: "a", window: { sourceStartMs: 0, sourceEndMs: 3500 } });
    expect(JSON.stringify(finding.fixes)).not.toContain("snapToBeat");
    const fixed = applyCommand(timeline, commandOf(finding), ctx);
    // Only the cut moves: no music, no title (the caption spans the cut and keeps its seconds).
    expect(fixed.changes).toEqual([{ kind: "clip", id: "a" }]);
    expect(ofCheck(run(fixed.timeline), "beat")).toEqual([]);
  });

  it("no tempo, no check", () => {
    expect(ofCheck(run(reel({ clips: withSong(3250).clips, music: { assetId: "song", bpm: null, beatOffsetMs: null } })), "beat")).toEqual([]);
  });
});

describe("fix all", () => {
  it("applies the safe fixes as one step and leaves the edit's own choices (order, trims, takes) alone", () => {
    const timeline = parseTimeline({
      version: 1,
      clips: [
        { id: "still", assetId: "p1", kind: "IMAGE", sourceStartMs: 0, sourceEndMs: 3250 },
        { id: "b", assetId: "v2", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 4000 },
      ],
      texts: [
        { id: "high", text: "Open Saturday", startMs: 100, endMs: 3000, y: 0.05 },
        { id: "ok", text: "Kitchen", startMs: 3500, endMs: 6000, y: 0.4 },
      ],
      music: { assetId: "song", bpm: 120, beatOffsetMs: 0 },
    });
    const frames = framesFor(timeline, () => flat(0.95));
    const findings = run(timeline, { frames, headline: "Villa" });
    expect(new Set(findings.map((f) => f.check))).toEqual(new Set(["safe-zone", "legibility", "dead-air", "beat", "loop"]));
    const command = fixAllCommand(findings)!;
    expect(command.type).toBe("batch");
    const commands = (command as Extract<Command, { type: "batch" }>).commands;
    // One updateText per title (the flagged one's move and shadow merged), then the snap's frame-exact trim.
    expect(commands.map((c) => c.type)).toEqual(["updateText", "updateText", "trimClip"]);
    expect(commands[0]).toMatchObject({ type: "updateText", textId: "high", patch: { shadow: "strong" } });
    const fixed = applyCommand(timeline, command, ctx);
    expect(fixed.rejected).toBeUndefined();
    // Titles change where they were flagged; the cut changes only by the snap (the still photo is not trimmed).
    const snapped = applyCommand(timeline, { type: "snapToBeat" }, ctx).timeline;
    expect(fixed.timeline.clips).toEqual(snapped.clips);
    expect(fixed.timeline.music).toEqual(timeline.music);
    expect(diffTimelines(timeline, fixed.timeline).filter((c) => c.kind === "text").map((c) => (c as { id: string }).id).sort()).toEqual(["high", "ok"]);
  });

  it("a small title low in the frame is made bigger and moved in one step, and the critic then has nothing safe left", () => {
    const timeline = reel({ clips: [{ id: "a", assetId: "v1", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 4000 }],
      texts: [{ id: "low", text: "Four\nlines\nof\ncopy", startMs: 200, endMs: 3500, y: 0.8, style: "elegant", size: 0.3 }] });
    const findings = run(timeline);
    // The elegant fade also means the title is not readable by 300 ms (a retention finding; its fix is not safe).
    expect(findings.map((f) => f.id).sort()).toEqual(["legibility-size:low", "opening:title:low", "safe-zone:low"]);
    const commands = (fixAllCommand(findings) as Extract<Command, { type: "batch" }>).commands;
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ type: "updateText", textId: "low", patch: { size: expect.any(Number), x: expect.any(Number), y: expect.any(Number) } });
    const fixed = applyCommand(timeline, fixAllCommand(findings)!, ctx);
    expect(fixed.changes).toEqual([{ kind: "text", id: "low" }]);
    expect(run(fixed.timeline).map((f) => f.id)).toEqual(["opening:title:low"]);
    expect(fixAllCommand(run(fixed.timeline))).toBeNull();
    // "Make it bigger" alone also keeps it out of the caption.
    const sizeOnly = applyCommand(timeline, commandOf(findings.find((f) => f.id === "legibility-size:low")!), ctx).timeline;
    expect(ofCheck(run(sizeOnly), "safe-zone")).toEqual([]);
  });

  it("nothing safe to fix is no command", () => {
    expect(fixAllCommand([])).toBeNull();
  });
});

describe("the commands the fixes use", () => {
  it("a batch is all or nothing; a duplicate title id is refused", () => {
    const timeline = reel({ texts: [{ id: "t", text: "Hi", startMs: 0, endMs: 1000 }] });
    const bad = applyCommand(timeline, { type: "batch", commands: [{ type: "updateText", textId: "t", patch: { y: 0.5 } }, { type: "addText", text: { id: "t", text: "Again", startMs: 0, x: 0.5, y: 0.5, style: "plain", color: "#ffffff", size: 1 } }] }, ctx);
    expect(bad.rejected).toMatch(/already/);
    expect(bad.timeline).toBe(timeline);
    expect(applyCommand(timeline, { type: "updateText", textId: "missing", patch: { y: 0.5 } }, ctx).rejected).toMatch(/no text/);
    // A step that would quietly do nothing fails the whole batch too.
    const hollow = applyCommand(timeline, { type: "batch", commands: [{ type: "updateText", textId: "t", patch: { y: 0.5 } }, { type: "updateText", textId: "gone", patch: { y: 0.6 } }] }, ctx);
    expect(hollow.rejected).toBeTruthy();
    expect(hollow.timeline).toBe(timeline);
    const past = applyCommand(timeline, { type: "addText", text: { id: "late", text: "Late", startMs: 1000, endMs: 1000, x: 0.5, y: 0.5, style: "plain", color: "#ffffff", size: 1 } }, ctx);
    expect(past.rejected).toMatch(/no room/);
  });
});

describe("frames and samples", () => {
  it("reads luma from RGBA and measures difference", () => {
    const white = lumaFromRgba([255, 255, 255, 255, 0, 0, 0, 255], 2, 1);
    expect(Array.from(white.luma)).toEqual([1, 0]);
    expect(frameDifference(flat(0.2), flat(0.5))).toBeCloseTo(0.3);
    expect(frameDifference(split(0, 1), flat(0, 9, 16))).toBeCloseTo(0.5);
  });

  it("never asks for more than the cap, and takes a clip's dead-air frames whole or not at all", () => {
    const clips = Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, assetId: `v${i}`, kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 6000 }));
    const timeline = reel({ clips });
    const samples = criticSamples(timeline);
    expect(samples.length).toBeLessThanOrEqual(CRITIC.maxSamples);
    expect(new Set(samples.map((s) => s.key)).size).toBe(samples.length);
    // A clip's grid (every 500 ms and its last frame) is read whole or the clip is left unjudged.
    const keys = new Set(samples.map((s) => s.key));
    const offsets = [0, 500, 1000, 1500, 2000, 2500, 3000, 3500, 4000, 4500, 5000, 5500, 5967];
    const whole = clips.filter((clip) => offsets.every((o) => keys.has(`${clip.id}@${o}`))).map((clip) => clip.id);
    expect(whole.length).toBeGreaterThan(0);
    expect(whole.length).toBeLessThan(clips.length);
    // Clips that did not fit the half-second grid get a one-second grid when that fits; the rest stay unjudged.
    const coarse = [0, 1000, 2000, 3000, 4000, 5000, 5967];
    const wholeCoarse = clips.filter((clip) => !whole.includes(clip.id) && coarse.every((o) => keys.has(`${clip.id}@${o}`))).map((clip) => clip.id);
    expect(wholeCoarse.length).toBeGreaterThan(0);
    const frames = new Map(samples.map((s) => [s.key, flat(0.3)]));
    const judged = ofCheck(run(timeline, { frames }), "dead-air").map((f) => f.clipId);
    // The last clip's final 3 s are read for the loop ends, so its still tail is judged from those frames.
    expect(new Set(judged.filter((id) => id !== "c11"))).toEqual(new Set([...whole, ...wholeCoarse]));
    expect(judged.length).toBeLessThan(clips.length);
  });
});
