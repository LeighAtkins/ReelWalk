import { describe, expect, it } from "vitest";
import { applyAiEditPlan, aiEditPlanSchema, type AiAsset, type AiEditOp } from "../src/ai-edit";
import { captionsFromSpeech, captionsWithWords } from "../src/transcript";
import { FOCUS, focusArrivals, focusReveal, KINETIC_LABELS, KINETIC_PRESET } from "../src/kinetic";
import { parseTimeline, timelineSchema, type Timeline } from "../src/timeline";

const spec = (fields: { wordsMs?: number[]; startMs?: number; durationMs?: number } = {}) => ({ preset: "focus" as const, ...fields });
const words = (parts: ReturnType<typeof focusReveal>) => parts.filter((part) => !part.space);

describe("focus: when each word arrives", () => {
  it("lands each word on its spoken onset when there is one time per word", () => {
    expect(focusArrivals("my favorite features", spec({ wordsMs: [0, 180, 640] }))).toEqual([0, 180, 640]);
  });

  it("staggers evenly so the last word is in focus at the end of the move when there are no times (or the wrong number)", () => {
    // 700 ms default: the last word starts 700 − 300 = 400 ms in.
    expect(KINETIC_PRESET.focus).toEqual({ startMs: 0, durationMs: 700 });
    expect(focusArrivals("this location", spec())).toEqual([0, 400]);
    expect(focusArrivals("single level estate", spec({ startMs: 100, durationMs: 870, wordsMs: [0, 10] }))).toEqual([100, 385, 670]);
    expect(focusArrivals("estate", spec())).toEqual([0]);
  });
});

describe("focus: how a word comes into focus", () => {
  const life = 2000, size = 120;

  it("is invisible before it is said: faint, blurred by 0.08 of its size and 1.15× large", () => {
    const [, second] = words(focusReveal("my favorite", spec({ wordsMs: [0, 300] }), 100, life, size));
    expect(second.opacity).toBe(0);
    expect(second.scale).toBeCloseTo(FOCUS.scaleFrom, 4);
    expect(second.blur).toBeCloseTo(FOCUS.blurEm * size, 3);
  });

  it("shrinks into focus over 300 ms, easing out (cubic), and is at rest after", () => {
    const at = (ms: number) => words(focusReveal("favorite", spec(), ms, life, size))[0];
    const half = at(150);
    // Ease-out cubic: seven eighths of the way at half the time.
    expect(half.opacity).toBeCloseTo(0.875, 3);
    expect(half.scale).toBeCloseTo(1 + 0.15 * 0.125, 3);
    expect(half.blur).toBeCloseTo(0.08 * 120 * 0.125, 2);
    expect(at(300)).toMatchObject({ opacity: 1, scale: 1, blur: 0, rise: 0 });
    expect(at(1200)).toMatchObject({ opacity: 1, scale: 1, blur: 0 });
    // Never larger than it starts, never smaller than its size: no overshoot.
    for (let ms = 0; ms <= 300; ms += 10) {
      const w = at(ms);
      expect(w.scale).toBeGreaterThanOrEqual(1);
      expect(w.scale).toBeLessThanOrEqual(FOCUS.scaleFrom);
    }
  });

  it("blurs and fades out as one over the title's last 250 ms", () => {
    const end = words(focusReveal("this location", spec(), life, life, size));
    expect(end.every((w) => w.opacity === 0)).toBe(true);
    expect(end.every((w) => Math.abs(w.blur - FOCUS.exitBlurEm * size) < 0.01)).toBe(true);
    const before = words(focusReveal("this location", spec(), life - 250, life, size));
    expect(before.every((w) => w.opacity === 1 && w.blur === 0)).toBe(true);
    // A short title keeps its way out to a third of its length.
    const short = words(focusReveal("estate", spec({ durationMs: 300 }), 450 - 150, 450, size))[0];
    expect(short.opacity).toBe(1);
  });

  it("keeps spaces and line breaks as parts, so the layout is the full text's", () => {
    const parts = focusReveal("Before\nI share", spec(), 0, life, size);
    expect(parts.map((part) => part.text)).toEqual(["Before", "\n", "I", " ", "share"]);
    expect(parts.filter((part) => part.space).every((part) => part.opacity === 1 && part.blur === 0)).toBe(true);
  });
});

describe("focus in the schema, the sheet and an ask", () => {
  it("saves as a kinetic preset with spoken times, and the tight font as a typeface; old titles still parse", () => {
    const timeline = parseTimeline({
      version: 1, clips: [], music: null,
      texts: [
        { id: "a", text: "my favorite", startMs: 0, endMs: 2000, font: "tight", blend: "invert", kinetic: { preset: "focus", wordsMs: [0, 200] } },
        { id: "b", text: "Old title", startMs: 0, endMs: 2000, font: "editorial", kinetic: { preset: "words" } },
      ],
    });
    expect(timeline.texts[0].kinetic?.preset).toBe("focus");
    expect(timeline.texts[0].font).toBe("tight");
    expect(timeline.texts[1].font).toBe("editorial");
    expect(KINETIC_LABELS.focus).toBe("Into focus");
    expect(timelineSchema.safeParse({ ...timeline, texts: [{ ...timeline.texts[0], font: "helvetica" }] }).success).toBe(false);
  });

  const blank: Omit<AiEditOp, "op"> = {
    clip: null, text: null, startMs: null, endMs: null, lengthMs: null, speed: null, filter: null, motion: null, transition: null, fit: null,
    volume: null, toPosition: null, content: null, style: null, color: null, size: null, y: null, songId: null, on: null, details: null,
    assetId: null, order: null, pieces: null, atClip: null, animation: null, zoom: null, corner: null, yaw: null, sweep: null,
  };
  const op = (fields: Partial<AiEditOp> & { op: AiEditOp["op"] }): AiEditOp => ({ ...blank, ...fields });
  const transcript = { text: "Before I share. My favourite features.", words: [{ w: "Before", s: 200, e: 500 }, { w: "I", s: 560, e: 640 }, { w: "share.", s: 660, e: 1000 }, { w: "My", s: 2000, e: 2150 }, { w: "favourite", s: 2180, e: 2700 }, { w: "features.", s: 2750, e: 3300 }] };
  const assets: Record<string, AiAsset> = {
    v: { id: "v", kind: "VIDEO", title: "talking head", durationMs: 8000, isPano: false, bpm: null, beatOffsetMs: null, transcript } as AiAsset,
  };
  const reel = (): Timeline => parseTimeline({
    version: 1, music: null,
    clips: [{ id: "c1", assetId: "v", kind: "VIDEO", sourceStartMs: 100, sourceEndMs: 6000 }],
    texts: [{ id: "t1", text: "Just listed", startMs: 0, endMs: 3000, style: "headline" }],
  });

  it("offers focus to the model and stores it as the kinetic preset, not an animation", () => {
    expect(aiEditPlanSchema.safeParse({ ops: [op({ op: "editText", text: 1, animation: "focus" })], note: "", questions: [], caption: null }).success).toBe(true);
    const { timeline } = applyAiEditPlan(reel(), { ops: [op({ op: "editText", text: 1, animation: "focus" })], note: "" }, { assets, songs: [] });
    expect(timeline.texts[0]).toMatchObject({ animation: "none", kinetic: { preset: "focus" } });
    // Any other arrival takes the focus off again.
    const back = applyAiEditPlan(timeline, { ops: [op({ op: "editText", text: 1, animation: "pop" })], note: "" }, { assets, songs: [] });
    expect(back.timeline.texts[0].animation).toBe("pop");
    expect(back.timeline.texts[0].kinetic).toBeUndefined();
  });

  it("captions speech with each word coming into focus on its spoken onset", () => {
    const { timeline } = applyAiEditPlan(reel(), { ops: [op({ op: "captionSpeech", clip: 1, animation: "focus", style: "headline" })], note: "" }, { assets, songs: [] });
    const captions = timeline.texts.filter((text) => text.id.startsWith("speech-"));
    expect(captions.map((text) => text.text)).toEqual(["Before I share.", "My favourite features."]);
    // Source 200 ms is reel 100 ms (the clip starts at source 100); words are timed from the caption's own start.
    expect(captions[0]).toMatchObject({ startMs: 100, animation: "none", kinetic: { preset: "focus", startMs: 0, wordsMs: [0, 360, 460] } });
    expect(captions[1].kinetic?.wordsMs).toEqual([0, 180, 750]);
    expect(timelineSchema.safeParse(timeline).success).toBe(true);
  });

  it("times each caption's words without changing the captions themselves", () => {
    const clip = reel().clips[0];
    const withWords = captionsWithWords(transcript, clip, 0);
    expect(withWords.map((phrase) => phrase.wordStartsMs)).toEqual([[100, 460, 560], [1900, 2080, 2650]]);
    expect(captionsFromSpeech(transcript, clip, 0)).toEqual(withWords.map(({ text, startMs, endMs }) => ({ text, startMs, endMs })));
  });
});
