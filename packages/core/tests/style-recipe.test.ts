import { describe, expect, it } from "vitest";
import {
  recipeCutsOnBeat, describeRecipe, effectSupport, EFFECT_FAMILIES, NAMED_EFFECTS, pacingOf, parseSceneCuts, recipeGaps, shotsFromCuts, speechOf,
  styleRecipeSchema, withMotion, type StyleRecipe,
} from "../src";

// The owner's reference of 2026-10-31 ("16 ways to hook viewers with a title", 13.77 s, 1080x1920): ffmpeg's scene
// cuts at 0.25, and its speech as faster-whisper small.en heard it.
const DURATION = 13_775;
const FFMPEG = [
  "[Parsed_showinfo_1 @ 0x1] n:   0 pts:  54000 pts_time:1.8     duration: 3000",
  "[Parsed_showinfo_1 @ 0x1] n:   1 pts:  56000 pts_time:1.86667 duration: 3000",
  "[Parsed_showinfo_1 @ 0x1] n:   2 pts: 292000 pts_time:9.73333 duration: 3000",
].join("\n");
const SENTENCES: [string, number, number][] = [
  ["Instead of typing out your subtitles, why not try it with a dot?", 0, 2700],
  ["Or try it with this line art effect?", 3240, 4720],
  ["Or maybe this drop-in effect?", 5220, 6640],
  ["Did I mention you can also try it with pixels effect?", 7100, 9100],
];
// Words spread evenly over each sentence, which is all speechOf reads.
const WORDS = SENTENCES.flatMap(([text, s, e]) => {
  const parts = text.split(" ");
  const step = (e - s) / parts.length;
  return parts.map((w, i) => ({ text: w, startMs: Math.round(s + i * step), endMs: Math.round(s + (i + 1) * step) }));
});

describe("parseSceneCuts and shotsFromCuts", () => {
  it("reads ffmpeg's cut times and merges the two-frame flash at the grid cut", () => {
    const cuts = parseSceneCuts(FFMPEG);
    expect(cuts).toEqual([1800, 1867, 9733]);
    expect(shotsFromCuts(cuts, DURATION)).toEqual([
      { startMs: 0, endMs: 1800 }, { startMs: 1800, endMs: 9733 }, { startMs: 9733, endMs: DURATION },
    ]);
  });
  it("drops cuts that would leave a sliver at either end and gives one shot when there are none", () => {
    expect(shotsFromCuts([50, 5000, 9900], 10_000)).toEqual([{ startMs: 0, endMs: 5000 }, { startMs: 5000, endMs: 10_000 }]);
    expect(shotsFromCuts([], 4000)).toEqual([{ startMs: 0, endMs: 4000 }]);
  });
});

describe("pacingOf, withMotion, recipeCutsOnBeat", () => {
  const shots = shotsFromCuts(parseSceneCuts(FFMPEG), DURATION);
  it("summarises the reference's three shots", () => {
    expect(pacingOf(shots)).toEqual({ shotCount: 3, medianShotMs: 4042, meanShotMs: 4592, cutsPerSecond: 0.15, firstCutMs: 1800 });
    expect(pacingOf([{ startMs: 0, endMs: 3000 }])).toMatchObject({ shotCount: 1, firstCutMs: null, cutsPerSecond: 0 });
  });
  it("averages motion samples per shot and leaves a shot without samples alone", () => {
    const out = withMotion(shots, [{ ms: 100, value: 0.1 }, { ms: 900, value: 0.3 }, { ms: 5000, value: 0.05 }]);
    expect(out.map((s) => s.motion)).toEqual([0.2, 0.05, undefined]);
  });
  it("counts the cuts within the tolerance of a beat", () => {
    expect(recipeCutsOnBeat(shots, [1790, 4000, 9900])).toBe(0.5);
    expect(recipeCutsOnBeat([{ startMs: 0, endMs: 1000 }], [0, 500])).toBe(0);
  });
});

describe("speechOf", () => {
  it("measures the reference's four spoken lines and ignores whisper's bracketed noise", () => {
    const speech = speechOf([...WORDS, { text: "[Music]", startMs: 12_000, endMs: 13_000 }], DURATION)!;
    expect(speech.words).toBe(37);
    expect(speech.firstWordMs).toBe(0);
    expect(speech.wordsPerMinute).toBeCloseTo(244, 0);
    expect(speech.spokenShare).toBeCloseTo(0.55, 2);
    expect(speech.text.startsWith("Instead of typing out your subtitles")).toBe(true);
  });
  it("is null when nothing is said", () => {
    expect(speechOf([], DURATION)).toBeNull();
    expect(speechOf([{ text: "[Music]", startMs: 0, endMs: 900 }], DURATION)).toBeNull();
  });
});

describe("effects", () => {
  it("names sixteen effects in four families of four", () => {
    expect(Object.keys(EFFECT_FAMILIES)).toEqual(["dots", "lineArt", "dropIns", "pixels"]);
    expect(NAMED_EFFECTS).toHaveLength(16);
  });
  it("knows ReelWalk's own animations and reports the named ones as missing, with their family", () => {
    expect(effectSupport("type")).toEqual({ supported: true, animation: "type" });
    expect(effectSupport("maskUp")).toEqual({ supported: true, animation: "maskUp" });
    expect(effectSupport("oneBigSlam")).toMatchObject({ supported: false, family: "dropIns" });
    expect(effectSupport("other")).toMatchObject({ supported: false, family: null });
  });
});

describe("a recipe", () => {
  const shots = shotsFromCuts(parseSceneCuts(FFMPEG), DURATION);
  const recipe: StyleRecipe = styleRecipeSchema.parse({
    version: 1, durationMs: DURATION, width: 1080, height: 1920, shots, pacing: pacingOf(shots), speech: speechOf(WORDS, DURATION), beat: null,
    titles: [
      { text: "really good", startMs: 200, endMs: 1800, effect: "type", look: "white sans, sentence case", spoken: false },
      { text: "title", startMs: 1300, endMs: 1800, effect: "type", look: "bold yellow sans", color: "#F5D547" },
      { text: "dot hop", startMs: 1900, endMs: 3200, effect: "dotHop" },
      { text: "slam.", startMs: 5300, endMs: 7100, effect: "oneBigSlam" },
      { text: "slingshot", startMs: 1950, endMs: 3200, effect: "slingshot" },
      { text: "swirl", startMs: 8000, endMs: 9000, effect: "other", effectNote: "letters spiral in" },
    ],
    format: "A talking-head hook, then a 4x4 grid of labelled demo tiles lit one family at a time, then an outro card.",
    notes: ["Outro: a dark card with an animated Instagram logo and the handle."],
  });

  it("lists what ReelWalk cannot draw yet, each effect once, in order", () => {
    expect(recipeGaps(recipe).map((g) => [g.effect, g.family, g.firstMs])).toEqual([
      ["dotHop", "dots", 1900], ["slingshot", "dots", 1950], ["oneBigSlam", "dropIns", 5300], ["other", null, 8000],
    ]);
    expect(recipeGaps(recipe).at(-1)?.note).toBe("letters spiral in");
  });

  it("describes itself plainly", () => {
    const text = describeRecipe(recipe);
    expect(text).toContain("13.8 s, 3 shots, first cut at 1.8 s");
    expect(text).toContain("Spoken: 37 words");
    expect(text).toContain("Not drawn by ReelWalk yet: dotHop, slingshot, oneBigSlam, other.");
    expect(text).toContain("Outro: a dark card");
  });

  it("refuses a title effect it does not know", () => {
    expect(() => styleRecipeSchema.parse({ ...recipe, titles: [{ text: "x", startMs: 0, endMs: 1, effect: "sparkle" }] })).toThrow();
  });
});

import { assembleRecipe, keyframeTimes, MAX_KEYFRAMES, motionSamples, parseReferenceRead, REFERENCE_READ_JSON_SCHEMA, referenceAnalysisSchema, TITLE_EFFECTS } from "../src";

describe("motionSamples", () => {
  it("is the mean absolute luma change from the previous frame", () => {
    const frame = (v: number[]) => ({ luma: Float32Array.from(v) });
    expect(motionSamples([{ ms: 0, frame: frame([0, 0]) }, { ms: 33, frame: frame([0.5, 0.25]) }, { ms: 67, frame: frame([0.5, 0.25]) }]))
      .toEqual([{ ms: 33, value: 0.375 }, { ms: 67, value: 0 }]);
    expect(motionSamples([])).toEqual([]);
  });
});

describe("keyframeTimes", () => {
  it("reads the first three seconds every 250 ms, then every 500 ms, plus each shot's start", () => {
    const times = keyframeTimes([{ startMs: 0, endMs: 1800 }, { startMs: 1800, endMs: 9733 }, { startMs: 9733, endMs: 13_775 }], 13_775);
    expect(times.slice(0, 13)).toEqual([0, 150, 250, 500, 750, 1000, 1250, 1500, 1750, 1950, 2000, 2250, 2500]);
    expect(times).toContain(9883);
    expect(times.at(-1)).toBe(13_500);
    expect(times.length).toBeLessThanOrEqual(MAX_KEYFRAMES);
  });
  it("thins a long reel evenly to the cap, keeping both ends", () => {
    const times = keyframeTimes([{ startMs: 0, endMs: 90_000 }], 90_000, 10);
    expect(times).toHaveLength(10);
    expect(times[0]).toBe(0);
    expect(times.at(-1)).toBe(89_500);
  });
});

describe("parseReferenceRead and assembleRecipe", () => {
  it("cleans a model answer: drops nulls and bad colours, clamps times and boxes, maps unknown effects to other", () => {
    const read = parseReferenceRead({
      format: " A talking head, then a grid. ",
      notes: ["Outro card", "", 4],
      titles: [
        { text: " try this ", startMs: 2100, endMs: 1900, box: { x: -0.1, y: 0.2, w: 1.4, h: 0.1 }, effect: "dotHop", effectNote: null, look: "white sans", color: "yellow", spoken: null },
        { text: "slam.", startMs: 5300, endMs: 99_000, box: null, effect: "megaSlam", effectNote: "slams", look: null, color: "#F5D547", spoken: false },
        { text: "   ", startMs: 0, endMs: 1, box: null, effect: "type", effectNote: null, look: null, color: null, spoken: null },
      ],
    }, 13_775);
    expect(read.format).toBe("A talking head, then a grid.");
    expect(read.notes).toEqual(["Outro card"]);
    expect(read.titles).toEqual([
      { text: "try this", startMs: 1900, endMs: 2100, effect: "dotHop", box: { x: 0, y: 0.2, w: 1, h: 0.1 }, look: "white sans" },
      { text: "slam.", startMs: 5300, endMs: 13_775, effect: "other", effectNote: "slams", color: "#F5D547", spoken: false },
    ]);
  });

  it("puts the worker's measurements and the reading together, and survives no reading", () => {
    const analysis = referenceAnalysisSchema.parse({
      version: 1, durationMs: 13_775, width: 1080, height: 1920,
      shots: [{ startMs: 0, endMs: 1800, motion: 0.04 }, { startMs: 1800, endMs: 9733, motion: 0.02 }, { startMs: 9733, endMs: 13_775, motion: 0.01 }],
      beat: { bpm: 120, beatsMs: [0, 500, 1000, 1500, 1800, 2500] }, words: WORDS, keyframes: [{ atMs: 0, key: "references/x/0.jpg" }],
    });
    const recipe = assembleRecipe(analysis, parseReferenceRead({ format: "Grid demo", notes: [], titles: [{ text: "dot hop", startMs: 1900, endMs: 3200, box: null, effect: "dotHop", effectNote: null, look: null, color: null, spoken: null }] }, 13_775));
    expect(recipe.pacing.firstCutMs).toBe(1800);
    expect(recipe.beat).toEqual({ bpm: 120, cutsOnBeatShare: 0.5 });
    expect(recipe.speech?.words).toBe(37);
    expect(recipe.format).toBe("Grid demo");
    expect(assembleRecipe(analysis, null).titles).toEqual([]);
  });

  it("offers the model exactly the effects the recipe accepts", () => {
    expect(REFERENCE_READ_JSON_SCHEMA.properties.titles.items.properties.effect.enum).toEqual([...TITLE_EFFECTS]);
  });
});
