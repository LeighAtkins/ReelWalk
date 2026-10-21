import { describe, expect, it, vi } from "vitest";
import { applyCommand, diffTimelines, type Command } from "../src/commands";
import {
  CRITIC,
  criticFaceFromGeneration,
  criticSamples,
  critique,
  fixAllCommand,
  frameDifference,
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
import { parseTimeline, timelineDurationMs, type TextOverlay, type Timeline } from "../src/timeline";

// The critic before export (ADR 0062): each check on a fixture reel, each fix as the command it should be,
// and no fix touching anything outside its scope.

const STYLE_SCALE: Record<string, number> = { headline: 1.3, elegant: 0.78, tag: 0.7 };
const titleFont = (text: TextOverlay): TitleFont => ({ fontSize: 76 * text.size * (STYLE_SCALE[text.style] ?? 1) });
const measure: Measure = (line, font) => ({ width: line.length * font.fontSize * 0.55, height: font.fontSize * 1.12 });

/** A flat frame of one luma. */
const flat = (luma: number, width = 18, height = 32): CriticFrame => ({ width, height, luma: new Float32Array(width * height).fill(luma) });
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
});

describe("dead air", () => {
  it("a still photo held over 2 s is trimmed to 1.5 s; one with a camera move is not dead", () => {
    const timeline = reel({ clips: [...reel().clips, { id: "p", assetId: "p1", kind: "IMAGE", sourceStartMs: 0, sourceEndMs: 5000 }] });
    const [finding] = ofCheck(run(timeline), "dead-air");
    expect(finding.severity).toBe("medium");
    expect(commandOf(finding)).toEqual({ type: "trimClip", clipId: "p", window: { sourceStartMs: 0, sourceEndMs: 1500 } });
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
    expect(commandOf(end)).toEqual({ type: "trimClip", clipId: "v", window: { sourceStartMs: 1000, sourceEndMs: 4500 } });
    expect(applyCommand(timeline, commandOf(end), ctx).changes.filter((c) => c.kind === "clip")).toEqual([{ kind: "clip", id: "v" }]);

    // Still from 1.5 s to 4.5 s into the shot, moving either side: half speed would not do, 1.5× would.
    const midStill = framesFor(timeline, (s) => (s.clipId === "v" && s.sourceMs >= 2500 && s.sourceMs <= 5500 ? flat(0.3) : moving(s.sourceMs)));
    const [middle] = ofCheck(run(timeline, { frames: midStill }), "dead-air");
    expect(commandOf(middle)).toEqual({ type: "setSpeed", clipId: "v", speed: 1.5 });
  });

  it("a title starting or ending breaks the stillness; unread video is not judged", () => {
    const clips = [{ id: "v", assetId: "v1", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 3600 }, ...reel().clips];
    const timeline = reel({ clips, texts: [{ id: "t", text: "Kitchen", startMs: 1800, endMs: 3000, y: 0.4 }] });
    const frames = framesFor(timeline, () => flat(0.3));
    expect(ofCheck(run(timeline, { frames }), "dead-air")).toEqual([]);
    expect(ofCheck(run(reel({ clips })), "dead-air")).toEqual([]);
    expect(ofCheck(run(reel({ clips }), { frames: framesFor(reel({ clips }), () => flat(0.3)) }), "dead-air")).toHaveLength(1);
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

  it("cuts between beats are snapped by the existing command; on-beat cuts say nothing", () => {
    expect(ofCheck(run(withSong(3000)), "beat")).toEqual([]);
    const timeline = withSong(3250);
    const [finding] = ofCheck(run(timeline), "beat");
    expect(finding.reason).toBe("1 of 1 cuts land between beats of the song.");
    expect(commandOf(finding)).toEqual({ type: "snapToBeat" });
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
        { id: "high", text: "Open Saturday", startMs: 200, endMs: 3000, y: 0.05 },
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
    // One updateText per title (the flagged one's move and shadow merged), then the snap.
    expect(commands.map((c) => c.type)).toEqual(["updateText", "updateText", "snapToBeat"]);
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
    expect(findings.map((f) => f.id).sort()).toEqual(["legibility-size:low", "safe-zone:low"]);
    const commands = (fixAllCommand(findings) as Extract<Command, { type: "batch" }>).commands;
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ type: "updateText", textId: "low", patch: { size: expect.any(Number), x: expect.any(Number), y: expect.any(Number) } });
    const fixed = applyCommand(timeline, fixAllCommand(findings)!, ctx);
    expect(fixed.changes).toEqual([{ kind: "text", id: "low" }]);
    expect(run(fixed.timeline)).toEqual([]);
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
    const frames = new Map(samples.map((s) => [s.key, flat(0.3)]));
    const judged = ofCheck(run(timeline, { frames }), "dead-air").map((f) => f.clipId);
    expect(new Set(judged)).toEqual(new Set(whole));
  });
});
