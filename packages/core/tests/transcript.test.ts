import { describe, expect, it } from "vitest";
import { applyAiEditPlan, captionsFromSpeech, clipSchema, describeReel, emptyTimeline, speechPhrases, type Transcript } from "../src";

// walk-e, as the worker's recogniser timed it.
const walk: Transcript = { text: "Double height living and light from every angle.", words: [
  { w: "Double", s: 800, e: 1100 }, { w: "height", s: 1100, e: 1560 }, { w: "living", s: 1560, e: 2360 }, { w: "and", s: 2360, e: 2780 },
  { w: "light", s: 2780, e: 3140 }, { w: "from", s: 3140, e: 3760 }, { w: "every", s: 3760, e: 4300 }, { w: "angle.", s: 4300, e: 5000 },
] };
const plane: Transcript = { text: "Who needs a front door? I'll just drop in.", words: [
  { w: "Who", s: 600, e: 780 }, { w: "needs", s: 780, e: 960 }, { w: "a", s: 960, e: 1140 }, { w: "front", s: 1140, e: 1580 }, { w: "door?", s: 1580, e: 2000 },
  { w: "I'll", s: 2140, e: 2800 }, { w: "just", s: 2800, e: 3040 }, { w: "drop", s: 3040, e: 3340 }, { w: "in.", s: 3340, e: 4000 },
] };

describe("speech captions", () => {
  it("breaks phrases at punctuation and before joining words", () => {
    expect(speechPhrases(walk.words).map((phrase) => phrase.text)).toEqual(["Double height living", "and light from every angle."]);
    expect(speechPhrases(plane.words).map((phrase) => phrase.text)).toEqual(["Who needs a front door?", "I'll just drop in."]);
  });

  it("breaks at a pause and never exceeds five words", () => {
    const words = Array.from({ length: 7 }, (_, index) => ({ w: `w${index}`, s: index * 300, e: index * 300 + 250 }));
    expect(speechPhrases(words).map((phrase) => phrase.text)).toEqual(["w0 w1 w2 w3 w4", "w5 w6"]);
    const paused = [{ w: "hello", s: 0, e: 400 }, { w: "there", s: 2000, e: 2400 }];
    expect(speechPhrases(paused)).toHaveLength(2);
  });

  it("maps source times to reel times through the clip's trim and speed", () => {
    const clip = clipSchema.parse({ id: "walk", assetId: "walk", kind: "VIDEO", sourceStartMs: 1000, sourceEndMs: 5500, speed: 1 });
    const captions = captionsFromSpeech(walk, clip, 11600);
    // "Double" starts at source 0.8 s, before the trim, so the first caption starts with the clip.
    expect(captions[0]).toMatchObject({ text: "Double height living", startMs: 11600 });
    expect(captions[1]).toMatchObject({ text: "and light from every angle.", startMs: 11600 + 2360 - 1000, endMs: 11600 + 5000 - 1000 });
    const fast = clipSchema.parse({ ...clip, speed: 2 });
    expect(captionsFromSpeech(walk, fast, 0)[1].startMs).toBe(Math.round((2360 - 1000) / 2));
  });

  it("captionSpeech lays timed captions over a clip and does not stack them when run again", () => {
    const clip = clipSchema.parse({ id: "plane", assetId: "plane", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 6800 });
    const timeline = { ...emptyTimeline(), clips: [clip] };
    const options = { assets: { plane: { id: "plane", kind: "VIDEO" as const, title: "plane", durationMs: 8000, isPano: false, bpm: null, beatOffsetMs: null, transcript: plane } }, songs: [], newId: () => "n" };
    const once = applyAiEditPlan(timeline, { note: "", ops: [{ op: "captionSpeech", clip: 1 }] } as never, options);
    expect(once.timeline.texts.map((text) => [text.text, text.startMs, text.endMs])).toEqual([
      ["Who needs a front door?", 600, 2000],
      ["I'll just drop in.", 2140, 4000],
    ]);
    expect(once.applied[0]).toMatch(/captioned the speech/);
    const twice = applyAiEditPlan(once.timeline, { note: "", ops: [{ op: "captionSpeech", clip: 1, y: 0.5 }] } as never, options);
    expect(twice.timeline.texts).toHaveLength(2);
    expect(twice.timeline.texts[0].y).toBe(0.5);
  });

  it("tells the model what a clip says, from the clip's own start", () => {
    const clip = clipSchema.parse({ id: "walk", assetId: "walk", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 5500, volume: 0 });
    const text = describeReel({ title: "Villa", timeline: { ...emptyTimeline(), clips: [clip] }, assets: { walk: { id: "walk", kind: "VIDEO", title: "walk", durationMs: 8000, isPano: false, bpm: null, beatOffsetMs: null, transcript: walk } }, songs: [] });
    expect(text).toContain('says (muted): 0.8–2.4 s "Double height living", 2.4–5.0 s "and light from every angle."');
  });
});
