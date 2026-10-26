import { describe, expect, it } from "vitest";
import {
  applyCommand, BUTTON_COLUMN_X, captionWordAt, COMMAND_TYPES, composeKeywordLockups, describeLockups, fitScreenTitle, KEYWORD_CAP, KEYWORD_SIZE_MAX,
  maxTextSize, parseTimeline, referencedAssetIds, phrasesOf, pickKeyword, placeKeyword, REEL_FORMAT, SAFE_AREA, screenTitleExtent, SERIF_CAP_EM, TEXT_SAFE_BOTTOM, TEXT_SIZE_MAX,
  textSchema, updateText, type Timeline, type TranscriptWord,
} from "../src";
import { LAST_MILE_KIT } from "../src/brand-kits";

// The owner's two Maya takes (2026-10-26), their whisper transcripts as stored (take 1 with its trailing hallucination).
const TAKE1 = "ai-take1", TAKE2 = "ai-take2";
const SPEECH: Record<string, TranscriptWord[]> = {
  [TAKE1]: [{ w: "Your", s: 280, e: 500 }, { w: "Listing,", s: 500, e: 1360 }, { w: "filmed", s: 1700, e: 2240 }, { w: "once.", s: 2240, e: 3520 }, { w: "One", s: 3820, e: 4200 }, { w: "reel,", s: 4200, e: 4920 }, { w: "cut", s: 4940, e: 5200 }, { w: "to", s: 5200, e: 5300 }, { w: "the", s: 5300, e: 5580 }, { w: "beat.", s: 5580, e: 6200 }, { w: "[\"The", s: 7780, e: 8780 }],
  [TAKE2]: [{ w: "Your", s: 200, e: 800 }, { w: "words", s: 800, e: 1680 }, { w: "on", s: 1680, e: 1840 }, { w: "the", s: 1840, e: 2400 }, { w: "walls,", s: 2400, e: 2680 }, { w: "done", s: 4260, e: 4860 }, { w: "before", s: 4860, e: 5280 }, { w: "the", s: 5280, e: 5640 }, { w: "open", s: 5640, e: 6040 }, { w: "home.", s: 6040, e: 6440 }],
};
const FACES = { [TAKE1]: { x0: 0.14, y0: 0.47, x1: 0.46, y1: 0.65, width: 1080, height: 1920 }, [TAKE2]: { x0: 0.49, y0: 0.39, x1: 0.81, y1: 0.57, width: 1080, height: 1920 } };

function reel(): Timeline {
  return parseTimeline({
    version: 1, music: null, texts: [{ id: "mine", text: "Kept", startMs: 0, endMs: 1000 }],
    clips: [
      { id: "clip-one", assetId: TAKE1, kind: "VIDEO", sourceStartMs: 200, sourceEndMs: 6450 },
      { id: "clip-two", assetId: TAKE2, kind: "VIDEO", sourceStartMs: 100, sourceEndMs: 8000 },
    ],
  });
}
const words = (asset: string) => SPEECH[asset].map((w) => ({ text: w.w, startMs: w.s, endMs: w.e }));

describe("phrasesOf", () => {
  it("splits at sentence ends and pauses, a long sentence at its commas, and drops whisper's bracketed noise", () => {
    expect(phrasesOf(words(TAKE1)).map((p) => p.words.map((w) => w.text).join(" "))).toEqual(["Your Listing,", "filmed once.", "One reel, cut to the beat."]);
    // A 1.6 s pause ends a phrase even after a comma.
    expect(phrasesOf(words(TAKE2)).map((p) => p.words.map((w) => w.text).join(" "))).toEqual(["Your words on the walls,", "done before the open home."]);
  });
});

describe("pickKeyword", () => {
  const pick = (text: string) => {
    const [phrase] = phrasesOf(text.split(" ").map((w, i) => ({ text: w, startMs: i * 300, endMs: i * 300 + 250 })));
    const index = pickKeyword(phrase);
    return index === null ? null : phrase.words[index].text;
  };
  it("prefers numbers, then a content word said early enough to hold, never a function word", () => {
    expect(pick("Your words on the walls")).toBe("words");
    expect(pick("filmed once")).toBe("once");
    expect(pick("it costs 16,000 dollars")).toBe("16,000");
    expect(pick("and so it is")).toBeNull();
  });
});

describe("placeKeyword", () => {
  it("sizes the capitals as asked, behind the head, inside the safe area and clear of the button column", () => {
    const face = { x0: 0.6, y0: 0.4, x1: 0.9, y1: 0.58 };
    const placed = placeKeyword("walls", KEYWORD_CAP, face);
    expect(placed.capHeight).toBe(KEYWORD_CAP);
    // size → px: the elegant style is 0.7 of the 76 px base; Playfair's capitals are 0.708 em.
    expect((placed.size * 76 * 0.7 * SERIF_CAP_EM) / REEL_FORMAT.height).toBeCloseTo(KEYWORD_CAP, 3);
    expect(placed.x + placed.widthFraction / 2).toBeLessThanOrEqual(BUTTON_COLUMN_X);
    expect(placed.x - placed.widthFraction / 2).toBeGreaterThanOrEqual(SAFE_AREA.left);
    // The head (face top less the hair) is below the capitals' top and above their baseline: it covers their bottom.
    const headTop = face.y0 - 0.28 * (face.y1 - face.y0);
    const fontH = (placed.size * 76 * 0.7) / REEL_FORMAT.height;
    const baseline = placed.y + 0.4155 * fontH;
    expect(headTop).toBeGreaterThan(baseline - placed.capHeight);
    expect(headTop).toBeLessThan(baseline);
  });

  it("shrinks a long word to fit and keeps a word without a face at the reference's height", () => {
    const long = placeKeyword("conversations", 0.12, null);
    expect(long.capHeight).toBeLessThan(0.12);
    expect(long.widthFraction).toBeLessThanOrEqual(BUTTON_COLUMN_X - SAFE_AREA.left);
    expect(long.y).toBeCloseTo(0.37, 2);
  });
});

describe("composeKeywordLockups", () => {
  const composed = composeKeywordLockups(reel(), { speech: SPEECH, faces: FACES, keywords: ["listing", "beat"] });
  const lockups = describeLockups(composed);

  it("makes one lockup per phrase, a keyword and a caption track, and keeps other titles", () => {
    expect(lockups.map((l) => l.keyword)).toEqual(["listing", "once", "beat", "words", "done"]);
    expect(lockups[2].captions).toEqual(["One", "reel", "cut", "to", "the"]);
    expect(composed.texts.some((t) => t.id === "mine")).toBe(true);
    expect(composed.texts.every((t) => textSchema.safeParse(t).success)).toBe(true);
  });

  it("brings each keyword in on its onset (40 ms ahead) with the measured quick blur, behind the presenter", () => {
    const beat = composed.texts.find((t) => t.lockup?.role === "keyword" && t.text === "beat")!;
    // "beat." at source 5580 ms; clip one starts at source 200.
    expect(beat.startMs).toBe(5580 - 200 - 40);
    expect(beat).toMatchObject({ animation: "blurQuick", behind: true, style: "elegant", weight: 600, color: "#ffffff" });
    expect(beat.size).toBeGreaterThan(TEXT_SIZE_MAX);
  });

  it("sets the caption words one at a time on their onsets, off when the keyword is said", () => {
    const captions = composed.texts.find((t) => t.lockup?.id === lockups[0].lockupId && t.lockup.role === "captions")!;
    // "Your" on 40 ms before 280 (source), i.e. reel 40; it goes when "Listing" is said (reel 300 − 40).
    expect(captions.startMs).toBe(40);
    expect(captions.kinetic).toMatchObject({ preset: "caption", wordsMs: [0], wordsOffMs: [220] });
    expect(captions.y).toBeLessThanOrEqual(TEXT_SAFE_BOTTOM);
    expect(captions.italic).toBe(true);
  });

  it("composes again in place, and adds a closing keyword after the last phrase", () => {
    const again = composeKeywordLockups(composed, { speech: SPEECH, faces: FACES, cta: { keyword: "Try it", caption: "free at reelwalking.com" } });
    expect(again.texts.filter((t) => t.lockup).length).toBe(composed.texts.filter((t) => t.lockup).length + 2);
    const close = describeLockups(again).at(-1)!;
    expect(close.keyword).toBe("Try it");
    expect(close.endMs).toBe(6250 + 7900);
    // It starts once the last phrase's keyword and captions are gone: nothing of two lockups shows at once.
    const last = describeLockups(again).at(-2)!;
    expect(close.startMs).toBeGreaterThanOrEqual(last.endMs);
  });

  it("keeps clips whose ids share a long prefix apart (presenter takes are script-ai-…)", () => {
    const twins = parseTimeline({ version: 1, music: null, texts: [], clips: [
      { id: "script-ai-cmvp4abc", assetId: TAKE1, kind: "VIDEO", sourceStartMs: 200, sourceEndMs: 6450 },
      { id: "script-ai-cmvp4def", assetId: TAKE2, kind: "VIDEO", sourceStartMs: 100, sourceEndMs: 8000 },
    ] });
    const both = composeKeywordLockups(twins, { speech: SPEECH });
    const ids = both.texts.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    // Composing the first clip again leaves the second clip's lockups alone.
    const again = composeKeywordLockups(both, { speech: SPEECH, clipIds: ["script-ai-cmvp4abc"] });
    expect(again.texts.filter((t) => t.lockup?.id.startsWith("script-ai-cmvp4def-")).length).toBe(both.texts.filter((t) => t.lockup?.id.startsWith("script-ai-cmvp4def-")).length);
    expect(again.texts.length).toBe(both.texts.length);
  });

  it("puts a keyword too short to show back into the captions instead of dropping the word", () => {
    // "beat." is said 5580–6200 ms; a clip cut at 5700 leaves it 160 ms.
    const short = parseTimeline({ version: 1, music: null, texts: [], clips: [{ id: "c", assetId: TAKE1, kind: "VIDEO", sourceStartMs: 3700, sourceEndMs: 5700 }] });
    const done = composeKeywordLockups(short, { speech: SPEECH, keywords: ["beat"], keywordsOnly: true });
    expect(done.texts.some((t) => t.lockup?.role === "keyword")).toBe(false);
    expect(done.texts.find((t) => t.lockup?.role === "captions")!.text.split(" ")).toContain("beat");
  });

  it("refuses clips with no speech, and unknown clips", () => {
    expect(() => composeKeywordLockups(reel(), { speech: {} })).toThrow(/no transcribed speech|None of those clips/);
    expect(() => composeKeywordLockups(reel(), { speech: SPEECH, clipIds: ["nope"] })).toThrow(/no clip called nope/);
  });
});

describe("the composeKeywordLockup command", () => {
  it("is registered, runs through applyCommand, and removes every lockup with remove", () => {
    expect(COMMAND_TYPES).toContain("composeKeywordLockup");
    const done = applyCommand(reel(), { type: "composeKeywordLockup", speech: SPEECH, faces: FACES }, { generation: 0 });
    expect(done.rejected).toBeUndefined();
    expect(done.timeline.texts.filter((t) => t.lockup).length).toBeGreaterThan(4);
    const removed = applyCommand(done.timeline, { type: "composeKeywordLockup", remove: true }, { generation: 1 });
    expect(removed.timeline.texts.map((t) => t.id)).toEqual(["mine"]);
    expect(applyCommand(reel(), { type: "composeKeywordLockup" }, { generation: 0 }).rejected).toMatch(/transcripts/);
  });

  it("sets a brand kit style on the keywords at the same pixel size, and refuses one without a kit", () => {
    const plain = applyCommand(reel(), { type: "composeKeywordLockup", speech: SPEECH, faces: FACES }, { generation: 0 }).timeline;
    const styled = applyCommand(reel(), { type: "composeKeywordLockup", speech: SPEECH, faces: FACES, brandStyle: "lastmile-title" }, { generation: 0, brandKit: LAST_MILE_KIT });
    expect(styled.rejected).toBeUndefined();
    const before = plain.texts.find((t) => t.id === "kw-clip-one-1")!, after = styled.timeline.texts.find((t) => t.id === "kw-clip-one-1")!;
    expect(after).toMatchObject({ style: "plain", brand: { style: "lastmile-title" }, x: before.x, y: before.y, startMs: before.startMs });
    // The plain style's base is the elegant serif's ÷ 0.7: the same px.
    expect(after.size).toBeCloseTo(before.size * 0.7, 4);
    expect(after.weight).toBeUndefined();
    // The caption words keep the house caption look.
    expect(styled.timeline.texts.find((t) => t.id === "kc-clip-one-1")!.brand).toBeUndefined();
    expect(applyCommand(reel(), { type: "composeKeywordLockup", speech: SPEECH, brandStyle: "x" }, { generation: 0 }).rejected).toMatch(/no brand kit/);
  });
});

describe("schema and editing", () => {
  it("lets only a lockup keyword pass the ordinary size limit, and keeps it through an edit", () => {
    const base = { id: "t", text: "big", startMs: 0, endMs: 1000, style: "elegant" as const, size: 4 };
    expect(textSchema.safeParse(base).success).toBe(false);
    expect(textSchema.safeParse({ ...base, lockup: { id: "a", role: "keyword" } }).success).toBe(true);
    expect(maxTextSize({ lockup: { role: "keyword" } })).toBe(KEYWORD_SIZE_MAX);
    const moved = updateText(composeKeywordLockups(reel(), { speech: SPEECH, faces: FACES }), "kw-clip-one-0", { x: 0.5 });
    expect(moved.texts.find((t) => t.id === "kw-clip-one-0")!.size).toBeGreaterThan(TEXT_SIZE_MAX);
  });

  it("counts a keyword's picture fill among the reel's assets, so it is loaded and exported", () => {
    const filled = parseTimeline({ version: 1, music: null, clips: reel().clips, texts: [{ id: "k", text: "home", startMs: 0, endMs: 1000, fill: { kind: "image", assetId: "photo-1" } }] });
    expect(referencedAssetIds(filled)).toContain("photo-1");
  });

  it("reads every saved title the same: no fill, italic, weight or lockup appears", () => {
    const saved = textSchema.parse({ id: "s", text: "Hello", startMs: 0, endMs: 1000 });
    expect(saved).not.toHaveProperty("fill");
    expect(saved).not.toHaveProperty("lockup");
  });
});

describe("captionWordAt", () => {
  const spec = { preset: "caption" as const, wordsMs: [0, 300, 900], wordsOffMs: [300, 600, 1400] };
  it("shows one word at a time, replaced on the next onset, and nothing in a gap", () => {
    expect(captionWordAt("one two three", spec, -1)).toBeNull();
    expect(captionWordAt("one two three", spec, 100)).toBe("one");
    expect(captionWordAt("one two three", spec, 350)).toBe("two");
    expect(captionWordAt("one two three", spec, 700)).toBeNull();
    expect(captionWordAt("one two three", spec, 1000)).toBe("three");
    expect(captionWordAt("one two three", spec, 1500)).toBeNull();
    // Without times: evenly over the duration, the last held.
    expect(captionWordAt("a b", { preset: "caption", durationMs: 1000 }, 800)).toBe("b");
  });

  it("fits a caption track as its widest word, not as the phrase", () => {
    const measure = (line: string) => ({ width: line.length * 30, height: 40 });
    const font = { fontSize: 76 };
    const text = { text: "a very long caption phrase made of many words indeed", style: "plain" as const, kinetic: { preset: "caption" as const } };
    expect(screenTitleExtent(text, font, measure, { mode: "line", maxWidth: 2000 }).width).toBe(7 * 30);
    const fitted = fitScreenTitle(text, font, measure, { x: 300, y: 900 }, 1, REEL_FORMAT.width);
    expect(fitted.center.x).toBe(300);
  });
});
