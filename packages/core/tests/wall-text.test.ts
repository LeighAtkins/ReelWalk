import { describe, expect, it } from "vitest";
import {
  alignSpokenLine, applyCommand, applyHomography, COMMAND_TYPES, homography, invertHomography, lineOnPlane, normaliseWord, parseTimeline, REEL_FORMAT,
  SERIF_CAP_EM, spokenWordsOfClip, speechSync, TITLE_LEADING, timelineSchema, titleAspect, wallPlane, wordReveal, type Quad, type TranscriptWord,
} from "../src";

// A wall receding to the left: its near (right) edge is tall, its far (left) edge short.
const WALL = [0.08, 0.2, 0.96, 0.04, 0.96, 0.92, 0.08, 0.7];
const px = (q: readonly number[]) => q.map((v, i) => (i % 2 === 0 ? v * REEL_FORMAT.width : v * REEL_FORMAT.height)) as Quad;
const edge = (q: readonly number[], a: number, b: number) => Math.hypot((q[b * 2] - q[a * 2]) * REEL_FORMAT.width, (q[b * 2 + 1] - q[a * 2 + 1]) * REEL_FORMAT.height);

describe("lineOnPlane", () => {
  const aspect = titleAspect("One reel, cut to the beat.");

  it("centres the line on the asked point with capitals the asked height", () => {
    const line = lineOnPlane(WALL, aspect, { at: { x: 0.45, y: 0.3 }, capHeight: 0.025 });
    if ("error" in line) throw new Error(line.error);
    const q = line.quad;
    // The centre of the plane rectangle (diagonals' crossing) is the point asked for.
    const H = homography([0, 0, 1, 0, 1, 1, 0, 1], px(q))!;
    const [cx, cy] = applyHomography(H, 0.5, 0.5);
    expect(cx / REEL_FORMAT.width).toBeCloseTo(0.45, 2);
    expect(cy / REEL_FORMAT.height).toBeCloseTo(0.3, 2);
    // Capitals as drawn: the mean of the left and right edges over the leading, times the serif's cap height.
    const cap = ((edge(q, 0, 3) + edge(q, 1, 2)) / 2) * SERIF_CAP_EM / TITLE_LEADING / REEL_FORMAT.height;
    expect(cap).toBeCloseTo(0.025, 3);
    expect(line.capHeight).toBeCloseTo(0.025, 3);
  });

  it("follows the wall's perspective: the far end of the line is shorter than the near end, and its sides converge with the wall's", () => {
    const line = lineOnPlane(WALL, aspect, { at: { x: 0.45, y: 0.32 } });
    if ("error" in line) throw new Error(line.error);
    expect(edge(line.quad, 0, 3)).toBeLessThan(edge(line.quad, 1, 2));
    // In the wall's own coordinates the line is an upright rectangle.
    const back = invertHomography(homography([0, 0, 1, 0, 1, 1, 0, 1], px(WALL))!)!;
    const uv = [0, 1, 2, 3].map((i) => applyHomography(back, line.quad[i * 2] * REEL_FORMAT.width, line.quad[i * 2 + 1] * REEL_FORMAT.height));
    expect(uv[0][1]).toBeCloseTo(uv[1][1], 2); expect(uv[3][1]).toBeCloseTo(uv[2][1], 2);
    expect(uv[0][0]).toBeCloseTo(uv[3][0], 2); expect(uv[1][0]).toBeCloseTo(uv[2][0], 2);
  });

  it("makes a two-line title two lines tall, with each line's capitals the asked height", () => {
    const one = lineOnPlane(WALL, titleAspect("One reel,"), { at: { x: 0.5, y: 0.4 }, capHeight: 0.02 });
    const two = lineOnPlane(WALL, titleAspect("One reel,\ncut to the beat."), { at: { x: 0.5, y: 0.4 }, capHeight: 0.02, lines: 2 });
    if ("error" in one || "error" in two) throw new Error("no fit");
    expect(two.capHeight).toBeCloseTo(0.02, 3);
    const height = (q: number[]) => (edge(q, 0, 3) + edge(q, 1, 2)) / 2;
    expect(height(two.quad) / height(one.quad)).toBeCloseTo(2, 1);
  });

  it("refuses a point off the wall and a line that leaves the safe area, saying which", () => {
    expect(lineOnPlane(WALL, aspect, { at: { x: 0.02, y: 0.5 } })).toEqual({ error: expect.stringMatching(/not on the surface/) });
    expect(lineOnPlane(WALL, aspect, { at: { x: 0.2, y: 0.3 }, capHeight: 0.08 })).toEqual({ error: expect.stringMatching(/safe area/) });
  });
});

describe("wallPlane", () => {
  it("builds a wall between two verticals whose top and bottom run to the vanishing point", () => {
    const vp = { x: 1.36, y: 0.89 };
    const q = wallPlane({ vanishingPoint: vp, x0: 0.05, x1: 0.55, top: 0.1, bottom: 0.7 });
    // Verticals stay vertical.
    expect(q[0]).toBe(0.05); expect(q[6]).toBe(0.05); expect(q[2]).toBe(0.55); expect(q[4]).toBe(0.55);
    expect(q[1]).toBe(0.1); expect(q[7]).toBe(0.7);
    // Top and bottom edges are collinear with the vanishing point.
    const collinear = (ax: number, ay: number, bx: number, by: number) => (bx - ax) * (vp.y - ay) - (by - ay) * (vp.x - ax);
    expect(collinear(q[0], q[1], q[2], q[3])).toBeCloseTo(0, 3);
    expect(collinear(q[6], q[7], q[4], q[5])).toBeCloseTo(0, 3);
    // Toward the vanishing point the wall is shorter: the far side of a receding wall.
    expect(q[5] - q[3]).toBeLessThan(q[7] - q[1]);
    expect(() => wallPlane({ vanishingPoint: { x: 0.05, y: 0.9 }, x0: 0.05, x1: 0.5, top: 0.1, bottom: 0.7 })).toThrow(/no perspective/);
  });

  it("carries a line that lineOnPlane lays in the same perspective", () => {
    const plane = wallPlane({ vanishingPoint: { x: 1.36, y: 0.89 }, x0: 0.02, x1: 0.56, top: 0.12, bottom: 0.7 });
    const line = lineOnPlane(plane, titleAspect("Your listing,\nfilmed once."), { at: { x: 0.3, y: 0.38 }, capHeight: 0.025 });
    if ("error" in line) throw new Error(line.error);
    expect(edge(line.quad, 1, 2)).toBeLessThan(edge(line.quad, 0, 3));
  });
});

const said = (text: string, from: number, step = 300): { text: string; startMs: number; endMs: number }[] =>
  text.split(" ").map((w, i) => ({ text: w, startMs: from + i * step, endMs: from + i * step + step - 40 }));

describe("alignSpokenLine", () => {
  it("normalises words the way a recogniser writes them", () => {
    expect(normaliseWord("Walls.")).toBe("walls");
    expect(normaliseWord("I'll")).toBe("ill");
    expect(normaliseWord("café")).toBe("cafe");
  });

  it("finds each written word in what is said, in order, with the words around the line left free", () => {
    const spoken = said("so here it is one reel cut to the beat okay", 1000);
    const a = alignSpokenLine("One reel, cut to the beat.", spoken)!;
    expect(a.matched).toBe(1);
    expect(a.matches).toEqual([4, 5, 6, 7, 8, 9]);
    expect(a.wordStartsMs).toEqual([2200, 2500, 2800, 3100, 3400, 3700]);
    expect(a.startMs).toBe(2200); expect(a.endMs).toBe(3960);
    expect(a.heard).toBe("one reel cut to the beat");
  });

  it("allows a letter's difference in longer words and places an unheard word between its neighbours", () => {
    const spoken = said("your words on the wall", 0);
    const a = alignSpokenLine("Your words, right on the walls.", spoken)!;
    expect(a.matches).toEqual([0, 1, null, 2, 3, 4]);
    expect(a.wordStartsMs[2]).toBeGreaterThan(a.wordStartsMs[1]);
    expect(a.wordStartsMs[2]).toBeLessThan(a.wordStartsMs[3]);
  });

  it("is null when too few of the words are heard", () => {
    expect(alignSpokenLine("Done before the open home.", said("a lovely kitchen with views", 0))).toBeNull();
    expect(alignSpokenLine("anything", [])).toBeNull();
  });
});

const words = (text: string, from: number, step = 300): TranscriptWord[] => said(text, from, step).map((w) => ({ w: w.text, s: w.startMs, e: w.endMs }));
const reel = () => parseTimeline({
  version: 1,
  clips: [
    { id: "a", assetId: "take1", kind: "VIDEO", sourceStartMs: 500, sourceEndMs: 6500 },
    { id: "b", assetId: "take2", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 5000 },
  ],
  texts: [
    { id: "l1", text: "Your listing, filmed once.", startMs: 0, endMs: 6000, style: "elegant" },
    { id: "l3", text: "Done before the open home.", startMs: 6000, endMs: 11000, style: "elegant" },
  ],
  music: null,
});
const speech = { take1: words("your listing filmed once one reel cut to the beat", 700, 400), take2: words("done before the open home", 1500) };
const ctx = { generation: 0, sourceDurationsMs: { take1: 8000, take2: 8000 } };

describe("spokenWordsOfClip", () => {
  it("reads a clip's words in reel time, inside its window", () => {
    const heard = spokenWordsOfClip(reel(), 0, speech);
    // Source 700 ms is 200 ms into a clip that starts at source 500.
    expect(heard[0]).toEqual({ text: "your", startMs: 200, endMs: 560 });
    expect(heard).toHaveLength(10);
    const second = spokenWordsOfClip(reel(), 1, speech);
    expect(second[0].startMs).toBe(6000 + 1500);
  });

  it("reads a J-cut's words from the sound under the clip", () => {
    const timeline = reel();
    timeline.clips[1] = { ...timeline.clips[1], audio: { assetId: "take1", sourceStartMs: 2300, volume: 1 } };
    const heard = spokenWordsOfClip(timeline, 1, speech);
    expect(heard[0].text).toBe("one");
    expect(heard[0].startMs).toBe(6000 + (2300 - 2300));
  });
});

describe("speechSync and the syncTextToSpeech command", () => {
  it("is in the registry the HTTP route accepts", () => {
    expect(COMMAND_TYPES).toContain("syncTextToSpeech");
  });

  it("starts the title on its first word, ends it after its last, and times each word as it is said", () => {
    const { patch, alignment } = speechSync(reel(), "l1", speech);
    expect(alignment.matched).toBe(1);
    // "your" at reel 200 ms, less the 60 ms lead; "once" ends at 200 + 3 × 400 + 360 = 1760, plus the 700 ms hold.
    expect(patch.startMs).toBe(140);
    expect(patch.endMs).toBe(1760 + 700);
    expect(patch.kinetic).toEqual({ preset: "words", startMs: 0, durationMs: 1200 + 420, wordsMs: [0, 400, 800, 1200] });
  });

  it("never runs past the shot, and keeps a short line up for at least 1.2 s", () => {
    const { patch } = speechSync(reel(), "l3", speech, { holdMs: 5000 });
    expect(patch.endMs).toBe(11000);
    const short = speechSync(reel(), "l3", speech, { holdMs: 0 });
    expect(short.patch.endMs - short.patch.startMs).toBeGreaterThanOrEqual(1200);
  });

  it("lands through the command as one change, and the reveal brings each word in on its time", () => {
    const result = applyCommand(reel(), { type: "syncTextToSpeech", textId: "l1", speech }, ctx);
    expect(result.rejected).toBeUndefined();
    expect(result.changes).toEqual([{ kind: "text", id: "l1" }]);
    expect(timelineSchema.safeParse(result.timeline).success).toBe(true);
    const text = result.timeline.texts.find((t) => t.id === "l1")!;
    // 450 ms into the title "your" and "listing," are arriving or in; "filmed" (800) and "once." (1200) are not yet.
    const parts = wordReveal(text.text, text.kinetic!, 450).filter((p) => !p.space);
    expect(parts[0].opacity).toBe(1);
    expect(parts[1].opacity).toBeGreaterThan(0);
    expect(parts[2].opacity).toBe(0);
    expect(parts[3].opacity).toBe(0);
    expect(wordReveal(text.text, text.kinetic!, 1200 + 420).every((p) => p.opacity === 1)).toBe(true);
  });

  it("is refused with what the clip says when the words are not there, and without transcripts", () => {
    const wrong = applyCommand(reel(), { type: "syncTextToSpeech", textId: "l3", clipId: "a", speech }, ctx);
    expect(wrong.rejected).toMatch(/it says "your listing filmed once/);
    expect(applyCommand(reel(), { type: "syncTextToSpeech", textId: "l1" }, ctx).rejected).toMatch(/transcripts/);
    expect(applyCommand(reel(), { type: "syncTextToSpeech", textId: "nope", speech }, ctx).rejected).toMatch(/no text called nope/);
    expect(applyCommand(reel(), { type: "syncTextToSpeech", textId: "l1", speech: { take2: speech.take2 } }, ctx).rejected).toMatch(/no transcribed speech/);
  });
});

describe("wordReveal with spoken times", () => {
  it("falls back to the even stagger when the times do not match the words", () => {
    const even = wordReveal("a b c", { preset: "words", startMs: 0, durationMs: 900 }, 300);
    const mismatched = wordReveal("a b c", { preset: "words", startMs: 0, durationMs: 900, wordsMs: [0, 10] }, 300);
    expect(mismatched).toEqual(even);
  });
});
