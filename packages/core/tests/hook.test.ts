import { describe, expect, it } from "vitest";
import {
  applyCommand,
  clipStartsMs,
  criticSamples,
  draftHookLines,
  HOOK_FRAME_MS,
  HOOK_INTERRUPT_CLIP_ID,
  HOOK_PATTERNS,
  HOOK_TEXT_PREFIX,
  hookPasses,
  hookRules,
  hookTextRequest,
  mostDifferentClip,
  openingMoments,
  parseTimeline,
  planHook,
  stripHook,
  strongestEarlyMotion,
  textAttachment,
  timelineDurationMs,
  titleLegibleAtMs,
  type CriticFrame,
  type HookInputs,
  type MotionSample,
  type Timeline,
} from "../src";

// The designed opening (ADR 0068): each pattern's planner on fixture reels, frame 0 never empty,
// the hook rules, and the command as one step.

const durations: Record<string, number> = { "v-a": 20000, "v-b": 20000, "v-c": 20000, "v-talk": 30000, "p-still": 0 };

/** Three videos and a still photo, a title attached to the second shot and a caption across the cuts. */
function reel(extra: Record<string, unknown> = {}): Timeline {
  return parseTimeline({
    version: 1,
    clips: [
      { id: "a", assetId: "v-a", kind: "VIDEO", sourceStartMs: 1000, sourceEndMs: 4000, volume: 0 },
      { id: "b", assetId: "v-b", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 3000, volume: 0, room: "kitchen" },
      { id: "s", assetId: "p-still", kind: "IMAGE", sourceStartMs: 0, sourceEndMs: 2500, room: "garden" },
      { id: "c", assetId: "v-c", kind: "VIDEO", sourceStartMs: 2000, sourceEndMs: 6000, volume: 0, filter: "mono" },
    ],
    texts: [
      { id: "kitchen", text: "The kitchen", startMs: 3400, endMs: 5400, style: "elegant" },
      { id: "caption", text: "Just listed", startMs: 1000, endMs: 9000, style: "tag", y: 0.3, size: 0.6 },
    ],
    music: null,
    ...extra,
  });
}

/** Steady samples: `speed` px per 100 ms step from `fromMs`, still before. */
const samples = (fromMs: number, toMs: number, speed: number, movingFromMs = fromMs): MotionSample[] =>
  Array.from({ length: Math.floor((toMs - fromMs) / 100) }, (_, i) => {
    const t = fromMs + i * 100;
    const moving = t >= movingFromMs;
    return { t, t2: t + 100, dx: moving ? speed : 0, dy: 0, change: moving && speed > 0 ? 0.03 : 0.002 };
  });

const words = (startMs: number, text: string) => text.split(" ").map((w, i) => ({ w, s: startMs + i * 300, e: startMs + i * 300 + 250 }));
const talking = () => parseTimeline({
  ...reel(),
  clips: [...reel().clips, { id: "talk", assetId: "v-talk", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 8000, volume: 1 }],
});
const speech: HookInputs["speech"] = { "v-talk": words(2200, "this kitchen changed my mind about the house") };

const hookTexts = (t: Timeline) => t.texts.filter((text) => text.id.startsWith(HOOK_TEXT_PREFIX));
const flat = (luma: number): CriticFrame => ({ width: 18, height: 32, luma: new Float32Array(18 * 32).fill(luma) });
const framesAt0 = (t: Timeline, frame: CriticFrame) => new Map([[criticSamples(t)[0].key, frame]]);

describe("voice-in", () => {
  it("puts the presenter's first word at 0 ms, the title at 0 ms, and moves the talking shot to the front", () => {
    const plan = planHook(talking(), "voice-in", { speech, sourceDurationsMs: durations });
    expect(plan).not.toBeNull();
    const { timeline, opening } = plan!;
    expect(timeline.clips[0].id).toBe("talk");
    // 80 ms of breath before the word.
    expect(timeline.clips[0].sourceStartMs).toBe(2120);
    expect(timeline.clips[0].sourceEndMs).toBe(8000);
    const title = timeline.texts.find((t) => t.id === `${HOOK_TEXT_PREFIX}title`)!;
    expect(title.startMs).toBe(0);
    expect(title.text).toBe("this kitchen changed my mind");
    expect(titleLegibleAtMs(title)).toBeLessThanOrEqual(100 + 50);
    expect(opening).toMatchObject({ pattern: "voice-in", clipId: "talk", inMs: 2120, titles: [title.text] });
  });

  it("uses the hook line given over the speech, and writes the promise under it", () => {
    const { timeline } = planHook(talking(), "voice-in", { speech, titles: ["She said no twice"], promise: "Then she saw the garden" })!;
    expect(hookTexts(timeline).map((t) => [t.text, t.startMs])).toEqual([["She said no twice", 0], ["Then she saw the garden", 700]]);
  });

  it("is not made without speech, or when the only words are past the window", () => {
    expect(planHook(reel(), "voice-in", { speech })).toBeNull();
    expect(planHook(talking(), "voice-in", { speech: { "v-talk": words(7800, "late words") } })).toBeNull();
  });

  it("keeps the attached title on its shot and the caption's seconds", () => {
    const before = talking();
    const { timeline } = planHook(before, "voice-in", { speech, sourceDurationsMs: durations })!;
    const starts = clipStartsMs(timeline);
    const b = timeline.clips.findIndex((clip) => clip.id === "b");
    const kitchen = timeline.texts.find((t) => t.id === "kitchen")!;
    expect(kitchen.startMs).toBe(starts[b] + 400);
    expect(textAttachment(timeline, kitchen)).toEqual({ kind: "clip", clipId: "b" });
    expect(timeline.texts.find((t) => t.id === "caption")).toMatchObject({ startMs: 1000, endMs: 9000 });
  });
});

describe("motion-in", () => {
  const motion = { a: samples(1000, 4000, 1), c: samples(2000, 6000, 0, 3500).map((s) => (s.t >= 3500 ? { ...s, dx: 9 } : s)) };

  it("opens on the clip measured to move most, started where its move is strongest", () => {
    const pick = strongestEarlyMotion(reel(), { motion });
    expect(pick).toMatchObject({ clipId: "c", inMs: 3500, measured: true });
    const { timeline, opening, note } = planHook(reel(), "motion-in", { motion, headline: "12 Harbour Lane", sourceDurationsMs: durations })!;
    expect(timeline.clips[0]).toMatchObject({ id: "c", sourceStartMs: 3500, sourceEndMs: 6000 });
    expect(timeline.clips.map((c) => c.id)).toEqual(["c", "a", "b", "s"]);
    expect(hookTexts(timeline)[0]).toMatchObject({ text: "12 Harbour Lane", startMs: 150 });
    expect(opening).toMatchObject({ pattern: "motion-in", clipId: "c", inMs: 3500 });
    expect(note).toContain("mid-move");
  });

  it("never starts a shot with less than 1.5 s left to play", () => {
    const late = { a: samples(1000, 4000, 0, 3800).map((s) => (s.t >= 3800 ? { ...s, dx: 20 } : s)) };
    const pick = strongestEarlyMotion(reel(), { motion: late })!;
    expect(pick.clipId).toBe("a");
    expect(pick.inMs).toBeLessThanOrEqual(4000 - 1500);
  });

  it("falls back to measured energies, then to a photo's camera move, and keeps the order among equals", () => {
    expect(strongestEarlyMotion(reel(), { clipEnergy: { b: 0.9, a: 0.2 } })).toMatchObject({ clipId: "b", inMs: 0, measured: true });
    const photoMoves = parseTimeline({ ...reel(), clips: reel().clips.map((c) => (c.id === "s" ? { ...c, motion: "snap-in" } : c)) });
    expect(strongestEarlyMotion(photoMoves, {})).toMatchObject({ clipId: "s", measured: false });
    expect(strongestEarlyMotion(reel(), {})).toMatchObject({ clipId: "a", measured: false });
  });

  it("leaves a presenter take where it is", () => {
    const withTake = parseTimeline({ ...reel(), clips: [...reel().clips, { id: "take", assetId: "ai-take", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 4000, volume: 1 }] });
    expect(strongestEarlyMotion(withTake, { clipEnergy: { take: 1 } })!.clipId).not.toBe("take");
  });
});

describe("text-punch", () => {
  it("lands the line fully legible by 300 ms with kinetic words, the promise after it", () => {
    const { timeline } = planHook(reel(), "text-punch", { titles: ["Would you live here?"], promise: "Every room in 15 s" })!;
    const [title, promise] = hookTexts(timeline);
    expect(title).toMatchObject({ startMs: 0, style: "headline", animation: "none", kinetic: { preset: "words", startMs: 0, durationMs: 300 } });
    expect(titleLegibleAtMs(title)).toBe(300);
    expect(promise).toMatchObject({ text: "Every room in 15 s", startMs: 450, style: "elegant" });
    expect(timeline.clips.map((c) => c.id)).toEqual(["a", "b", "s", "c"]);
  });

  it("needs a line: the reel's name will do, nothing will not", () => {
    expect(planHook(reel(), "text-punch", {})).toBeNull();
    expect(hookTexts(planHook(reel(), "text-punch", { headline: "Villa Sol" })!.timeline)[0].text).toBe("Villa Sol");
  });
});

describe("pattern-interrupt", () => {
  it("opens on 0.6 s of the shot least like the story's first, then cuts to the story", () => {
    const { timeline, opening } = planHook(reel(), "pattern-interrupt", { clipLuma: { a: 0.4, b: 0.45, s: 0.42, c: 0.95 }, headline: "Sold in a day" })!;
    expect(timeline.clips[0]).toMatchObject({ id: HOOK_INTERRUPT_CLIP_ID, assetId: "v-c", sourceStartMs: 2000, sourceEndMs: 2600, transitionIn: "cut", volume: 0 });
    expect(timeline.clips[1]).toMatchObject({ id: "a", transitionIn: "cut" });
    expect(timeline.clips.map((c) => c.id)).toEqual([HOOK_INTERRUPT_CLIP_ID, "a", "b", "s", "c"]);
    expect(timelineDurationMs(timeline)).toBe(timelineDurationMs(reel()) + 600);
    expect(opening).toMatchObject({ pattern: "pattern-interrupt", clipId: HOOK_INTERRUPT_CLIP_ID });
    // The attached title moved with its shot; the caption kept its seconds.
    const starts = clipStartsMs(timeline);
    expect(timeline.texts.find((t) => t.id === "kitchen")!.startMs).toBe(starts[2] + 400);
    expect(timeline.texts.find((t) => t.id === "caption")).toMatchObject({ startMs: 1000, endMs: 9000 });
  });

  it("picks by kind, room and look when nothing was measured, and never a 360 or a presenter take", () => {
    expect(mostDifferentClip(reel(), {})!.id).toBe("s");
    const withPano = parseTimeline({ ...reel(), clips: reel().clips.map((c) => (c.id === "s" ? { ...c, pano: { yawStart: 0, yawEnd: 90, pitch: 0, fov: 90 } } : c)) });
    expect(mostDifferentClip(withPano, {})!.id).not.toBe("s");
    expect(planHook(parseTimeline({ ...reel(), clips: reel().clips.slice(0, 1) }), "pattern-interrupt", {})).toBeNull();
  });
});

describe("question", () => {
  it("opens on a boxed question with the answer promised under it", () => {
    const { timeline } = planHook(reel(), "question", { titles: ["Would you pay 1.2M for this"], promise: "The number at the end" })!;
    const [q, promise] = hookTexts(timeline);
    expect(q).toMatchObject({ text: "Would you pay 1.2M for this?", style: "box", startMs: 0 });
    expect(promise).toMatchObject({ text: "The number at the end", startMs: 500 });
  });

  it("asks the reel's name when no line is given, with a plain promise", () => {
    const { timeline } = planHook(reel(), "question", { headline: "Villa Sol." })!;
    expect(hookTexts(timeline).map((t) => t.text)).toEqual(["Villa Sol?", "Watch to the end"]);
    expect(planHook(reel(), "question", {})).toBeNull();
  });
});

describe("every pattern", () => {
  const inputs: HookInputs = { speech, titles: ["Wait for the garden"], promise: "It gets better", headline: "Villa Sol", clipLuma: { a: 0.2, c: 0.9 }, motion: { c: samples(2000, 6000, 8) }, sourceDurationsMs: durations };

  it("never leaves frame 0 empty: a clip is on screen at 0 ms with at least half a second to play, and a title is legible by 300 ms", () => {
    for (const pattern of HOOK_PATTERNS) {
      // Voice-in needs a speaking shot; the other patterns are made from any reel.
      for (const fixture of pattern === "voice-in" ? [talking()] : [talking(), reel(), parseTimeline({ ...reel(), texts: [] })]) {
        const plan = planHook(fixture, pattern, inputs);
        expect(plan, pattern).not.toBeNull();
        const { timeline } = plan!;
        expect(timeline.clips.length, pattern).toBeGreaterThan(0);
        const moments = openingMoments(timeline);
        expect(moments[0], pattern).toMatchObject({ atMs: 0, clipId: timeline.clips[0].id });
        expect(moments.map((m) => m.atMs), pattern).toEqual([...HOOK_FRAME_MS]);
        const rules = hookRules(timeline, { speech, motion: inputs.motion, frames: framesAt0(timeline, flat(0.5)) });
        expect(rules.find((r) => r.rule === "frame-0"), pattern).toMatchObject({ ok: true });
        expect(rules.find((r) => r.rule === "title-300"), pattern).toMatchObject({ ok: true });
        expect(rules.filter((r) => r.rule === "zones").every((r) => r.ok), pattern).toBe(true);
        expect(parseTimeline(timeline).opening?.pattern).toBe(pattern);
      }
    }
  });

  it("is deterministic and re-plans from a clean slate: a second pattern replaces the first's texts and interrupt", () => {
    const once = planHook(reel(), "pattern-interrupt", inputs)!.timeline;
    expect(planHook(reel(), "pattern-interrupt", inputs)!.timeline).toEqual(once);
    const again = planHook(once, "question", inputs)!.timeline;
    expect(again.clips.some((c) => c.id === HOOK_INTERRUPT_CLIP_ID)).toBe(false);
    expect(hookTexts(again).map((t) => t.id)).toEqual([`${HOOK_TEXT_PREFIX}question`, `${HOOK_TEXT_PREFIX}promise`]);
    expect(again.opening?.pattern).toBe("question");
    const cleared = stripHook(again);
    expect(hookTexts(cleared)).toEqual([]);
    expect(cleared.opening).toBeUndefined();
  });

  it("goes through applyCommand as one change set, and pattern null clears it", () => {
    const before = talking();
    const result = applyCommand(before, { type: "hook", pattern: "voice-in", speech, titles: ["Hear her out"] }, { generation: 3, sourceDurationsMs: durations });
    expect(result.rejected).toBeUndefined();
    expect(result.timeline.opening?.pattern).toBe("voice-in");
    expect(result.changes).toEqual(expect.arrayContaining([{ kind: "other", key: "opening" }, { kind: "clip", id: "talk" }, { kind: "text", id: `${HOOK_TEXT_PREFIX}title` }]));
    const cleared = applyCommand(result.timeline, { type: "hook", pattern: null }, { generation: 4 });
    expect(hookTexts(cleared.timeline)).toEqual([]);
    expect(cleared.timeline.opening).toBeUndefined();
    const refused = applyCommand(reel(), { type: "hook", pattern: "voice-in" }, { generation: 5 });
    expect(refused.rejected).toContain("voice-in");
    expect(refused.changes).toEqual([]);
  });

  it("a saved reel without an opening parses as before", () => {
    const saved = reel();
    expect("opening" in saved ? saved.opening : undefined).toBeUndefined();
    expect(parseTimeline({ ...saved, opening: null }).opening).toBeNull();
  });
});

describe("the hook rules", () => {
  it("flags an empty frame 0, a late title, a still opening and a title under the header or buttons", () => {
    const still = parseTimeline({
      ...reel(),
      clips: [{ id: "s", assetId: "p-still", kind: "IMAGE", sourceStartMs: 0, sourceEndMs: 3000 }, ...reel().clips],
      texts: [{ id: "late", text: "Later", startMs: 200, endMs: 2000, style: "elegant", animation: "fade" }, { id: "high", text: "Up top", startMs: 0, endMs: 1000, y: 0.03, animation: "fade" }, { id: "right", text: "Right by the buttons", startMs: 0, endMs: 1000, x: 0.95, size: 0.6, animation: "fade" }],
    });
    const issues = hookRules(still, { frames: framesAt0(still, flat(0.01)) });
    expect(issues.find((i) => i.rule === "frame-0")).toMatchObject({ ok: false });
    expect(issues.find((i) => i.rule === "title-300")).toMatchObject({ ok: false, textId: "high" });
    expect(issues.find((i) => i.rule === "motion-500")).toMatchObject({ ok: false });
    expect(issues.filter((i) => i.rule === "zones").map((i) => i.textId).sort()).toEqual(["high", "right"]);
    expect(hookPasses(issues)).toBe(false);
  });

  it("says what it could not judge rather than guessing", () => {
    const issues = hookRules(parseTimeline({ ...reel(), texts: [{ id: "t", text: "Now", startMs: 0, endMs: 1000 }] }), {});
    expect(issues.find((i) => i.rule === "frame-0")).toMatchObject({ ok: true, unknown: true });
    expect(issues.find((i) => i.rule === "motion-500")).toMatchObject({ ok: true, unknown: true });
    expect(issues.find((i) => i.rule === "title-300")).toMatchObject({ ok: true });
  });

  it("counts a camera move, a cut, speech, kinetic type or measured motion in the first half second", () => {
    const motion = (t: Timeline, input = {}) => hookRules(t, input).find((i) => i.rule === "motion-500")!;
    expect(motion(parseTimeline({ ...reel(), clips: reel().clips.map((c, i) => (i === 0 ? { ...c, motion: "pan" } : c)) }))).toMatchObject({ ok: true });
    expect(motion(parseTimeline({ ...reel(), clips: reel().clips.map((c, i) => (i === 0 ? { ...c, sourceEndMs: 1500 } : c)) }))).toMatchObject({ ok: true, reason: expect.stringContaining("cut") });
    const talk = parseTimeline({ ...reel(), clips: [{ id: "talk", assetId: "v-talk", kind: "VIDEO", sourceStartMs: 2100, sourceEndMs: 8000, volume: 1 }] });
    expect(motion(talk, { speech })).toMatchObject({ ok: true, reason: expect.stringContaining("speaks") });
    expect(motion(planHook(reel(), "text-punch", { titles: ["Go"] })!.timeline)).toMatchObject({ ok: true, reason: expect.stringContaining("moves in") });
    expect(motion(reel(), { motion: { a: samples(1000, 4000, 9) } })).toMatchObject({ ok: true });
    expect(motion(reel(), { motion: { a: samples(1000, 4000, 0) } })).toMatchObject({ ok: false });
  });

  it("knows how long each entrance takes", () => {
    expect(titleLegibleAtMs({ text: "Hi", style: "plain", animation: "none" })).toBe(0);
    expect(titleLegibleAtMs({ text: "Hi", style: "plain", animation: "auto" })).toBe(150);
    expect(titleLegibleAtMs({ text: "Hi", style: "elegant", animation: "auto" })).toBe(600);
    expect(titleLegibleAtMs({ text: "Hi", style: "plain", animation: "rise" })).toBe(500);
    expect(titleLegibleAtMs({ text: "fourteen chars", style: "plain", animation: "type" })).toBe(1000);
    expect(titleLegibleAtMs({ text: "Hi", style: "plain", animation: "pop", kinetic: { preset: "words" } })).toBe(900);
    expect(titleLegibleAtMs({ text: "$1.2M", style: "plain", animation: "pop", kinetic: { preset: "count" } })).toBe(150);
  });
});

describe("hook lines", () => {
  it("hears a request for hook lines and how many", () => {
    expect(hookTextRequest("write me 5 hooks")).toEqual({ count: 5 });
    expect(hookTextRequest("Write 3 hook lines for this")).toEqual({ count: 3 });
    expect(hookTextRequest("give me some hooks")).toEqual({ count: 5 });
    expect(hookTextRequest("write me 20 hooks")).toEqual({ count: 8 });
    expect(hookTextRequest("make the hook a question")).toBeNull();
    expect(hookTextRequest("cut the hallway")).toBeNull();
  });

  it("drafts plain lines from what the reel knows when there is no model", () => {
    const lines = draftHookLines({ title: "Villa Sol", rooms: ["kitchen", "pool"], price: "$1.2M" }, 5);
    expect(lines).toHaveLength(5);
    expect(lines).toContain("Wait for the pool.");
    expect(lines).toContain("$1.2M. Here is what that buys.");
    expect(new Set(lines).size).toBe(5);
    expect(draftHookLines({ title: "" }, 2)).toHaveLength(2);
  });
});
