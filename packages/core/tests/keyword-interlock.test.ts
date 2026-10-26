import { describe, expect, it } from "vitest";
import {
  BUTTON_COLUMN_X, COMPANION_CAP_RATIO, COMPANION_OVER_OVERLAP, COMPANION_OVERLAP, composeKeywordLockups, describeLockups, INTERLOCK_MAX_WORDS, KEYWORD_CAP, maxTextSize, parseTimeline,
  placeCompanions, placeKeyword, REEL_FORMAT, SAFE_AREA, SERIF_CAP_EM, TEXT_SAFE_BOTTOM, TEXT_SIZE_MAX, textSchema, type TextOverlay, type Timeline, type TranscriptWord,
} from "../src";

// The 2026-10-26 wide pier take: "Before you list," then (after Veo's garble is cut out) "Ask yourself one thing."
const PIER = "ai-pier";
const SPEECH: Record<string, TranscriptWord[]> = {
  [PIER]: [
    { w: "Before", s: 0, e: 1080 }, { w: "you", s: 1080, e: 1320 }, { w: "list,", s: 1320, e: 1720 },
    { w: "Ask", s: 4940, e: 5200 }, { w: "yourself", s: 5200, e: 5580 }, { w: "one", s: 5580, e: 5920 }, { w: "thing.", s: 5920, e: 6360 },
  ],
};
// Her face as the gate gave it on the composed still (head top about 0.48 of the frame).
const FACES = { [PIER]: { x0: 0.45, y0: 0.52, x1: 0.58, y1: 0.61, width: 1080, height: 1920 } };

function reel(): Timeline {
  return parseTimeline({ version: 1, music: null, texts: [], clips: [{ id: "pier", assetId: PIER, kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 8000 }] });
}
const H = REEL_FORMAT.height;
const capOf = (text: TextOverlay, pxPerSize: number, capEm: number) => (text.size * pxPerSize * capEm) / H;
const keywordCap = (text: TextOverlay) => capOf(text, 76 * 0.7, SERIF_CAP_EM);
const companionCap = (text: TextOverlay) => capOf(text, 76, 0.695);
const keywordBaseline = (text: TextOverlay) => text.y + (0.4155 * text.size * 76 * 0.7) / H;

describe("placeCompanions", () => {
  const keyword = placeKeyword("Before", KEYWORD_CAP, { x0: 0.45, y0: 0.52, x1: 0.58, y1: 0.61 });

  it("tucks the words after the keyword under its right half and the words before over its top-left, a third of its size", () => {
    const placed = placeCompanions(keyword, "ask", "you list")!;
    expect(placed.map((p) => [p.text, p.position])).toEqual([["ask", "over"], ["you list", "under"]]);
    const [over, under] = placed;
    const cap = keyword.capHeight;
    for (const line of placed) expect(line.capHeight).toBeCloseTo(COMPANION_CAP_RATIO * cap, 3);
    const left = keyword.x - keyword.widthFraction / 2, right = keyword.x + keyword.widthFraction / 2;
    // Right-aligned just inside the keyword's right edge; left-aligned just inside its left edge.
    expect(under.x + under.widthFraction / 2).toBeLessThan(right);
    expect(under.x + under.widthFraction / 2).toBeGreaterThan(right - 0.05 * keyword.widthFraction);
    expect(over.x - over.widthFraction / 2).toBeGreaterThan(left);
    expect(over.x - over.widthFraction / 2).toBeLessThan(left + 0.05 * keyword.widthFraction);
    // Interlocked: the line under reaches up into the keyword's capitals; the line over sits on its cap line.
    const fontH = (keyword.size * 76 * 0.7) / H;
    const baseline = keyword.y + 0.4155 * fontH, capTop = baseline - cap;
    expect(under.y - under.capHeight / 2).toBeCloseTo(baseline - COMPANION_OVERLAP * cap, 2);
    expect(over.y + over.capHeight / 2).toBeCloseTo(capTop + COMPANION_OVER_OVERLAP * cap, 2);
  });

  it("refuses a line too wide to read as one block with the keyword, or one that would leave the safe area", () => {
    expect(placeCompanions(placeKeyword("go", KEYWORD_CAP, null), "", "absolutely everywhere at once")).toBeNull();
    const high = placeKeyword("Before", KEYWORD_CAP, null, { x: 0.5, y: 0 });
    // The keyword itself is clamped under the header; a line over it would cross into the header.
    expect(placeCompanions({ ...high, y: SAFE_AREA.top + 0.01 }, "ask", "")).toBeNull();
    const low = placeKeyword("Before", KEYWORD_CAP, null, { x: 0.5, y: 1 });
    expect(placeCompanions({ ...low, y: TEXT_SAFE_BOTTOM - 0.01 }, "", "you list")).toBeNull();
  });

  it("keeps every line clear of the button column", () => {
    const right = placeKeyword("Before", KEYWORD_CAP, null, { x: 1, y: 0.4 });
    for (const line of placeCompanions(right, "", "you list")!) expect(line.x + line.widthFraction / 2).toBeLessThanOrEqual(BUTTON_COLUMN_X);
  });
});

describe("composeKeywordLockups with interlock", () => {
  const composed = composeKeywordLockups(reel(), { speech: SPEECH, faces: FACES, keywords: ["Before", "yourself"] });
  const lockups = describeLockups(composed);
  const titles = (role: string) => composed.texts.filter((t) => t.lockup?.role === role);

  it("interlocks a short phrase instead of the caption track", () => {
    expect(lockups.map((l) => [l.keyword, l.layout])).toEqual([["Before", "interlock"], ["yourself", "interlock"]]);
    expect(titles("captions")).toHaveLength(0);
    expect(lockups[0].phrase).toBe("Before / you list");
    expect(lockups[1].phrase).toBe("Ask / yourself / one thing");
    expect(lockups[1].companions!.map((c) => c.text)).toEqual(["Ask", "one thing"]);
  });

  it("sets companions as small light italic, in front of her, each word on its onset, leaving with the keyword", () => {
    const keyword = composed.texts.find((t) => t.id === "kw-pier-0")!;
    const under = composed.texts.find((t) => t.id === "kp-under-pier-0")!;
    expect(keyword.behind).toBe(true);
    expect(under).toMatchObject({ text: "you list", style: "plain", italic: true, weight: 500, shadow: "soft", animation: "blurQuick", lockup: { id: "pier-0", role: "companion" } });
    expect(under.behind).toBeUndefined();
    expect(under.kinetic).toMatchObject({ preset: "words", startMs: 0, wordsMs: [0, 240] });
    expect(under.startMs).toBe(1040);
    expect(under.endMs).toBe(keyword.endMs);
    expect(companionCap(under)).toBeCloseTo(COMPANION_CAP_RATIO * keywordCap(keyword), 3);
    // Its capitals' top sits inside the keyword's capitals, above the keyword's baseline.
    expect(under.y - companionCap(under) / 2).toBeLessThan(keywordBaseline(keyword));
    expect(maxTextSize(under)).toBe(TEXT_SIZE_MAX);
  });

  it("keeps the one-word caption track for a phrase longer than INTERLOCK_MAX_WORDS, and when interlock is off", () => {
    const long: Record<string, TranscriptWord[]> = { [PIER]: ["Will", "your", "reel", "stop", "the", "scroll?"].map((w, i) => ({ w, s: i * 300, e: i * 300 + 260 })) };
    expect(long[PIER].length).toBeGreaterThan(INTERLOCK_MAX_WORDS);
    const one = describeLockups(composeKeywordLockups(reel(), { speech: long, faces: FACES, keywords: ["scroll"] }));
    expect(one.map((l) => [l.keyword, l.layout, l.captions])).toEqual([["scroll", "captions", ["Will", "your", "reel", "stop", "the"]]]);
    const off = describeLockups(composeKeywordLockups(reel(), { speech: SPEECH, faces: FACES, keywords: ["Before", "yourself"], interlock: false }));
    expect(off.map((l) => l.layout)).toEqual(["captions", "captions"]);
  });

  it("falls back to captions when the companions do not fit with the keyword", () => {
    const wide: Record<string, TranscriptWord[]> = { [PIER]: [{ w: "Go", s: 0, e: 300 }, { w: "absolutely", s: 300, e: 900 }, { w: "everywhere.", s: 900, e: 1600 }] };
    const [only] = describeLockups(composeKeywordLockups(reel(), { speech: wide, faces: FACES, keywords: ["Go"] }));
    expect(only.layout).toBe("captions");
    expect(only.captions).toEqual(["absolutely", "everywhere"]);
  });

  it("interlocks a short closing line under the call to action, and keeps a long one as captions", () => {
    const withCta = composeKeywordLockups(reel(), { speech: SPEECH, faces: FACES, keywords: ["Before", "yourself"], cta: { keyword: "free", caption: "at reelwalking.com" } });
    const closer = describeLockups(withCta).find((l) => l.keyword === "free")!;
    expect(closer.layout).toBe("interlock");
    expect(closer.companions!.map((c) => c.text)).toEqual(["at reelwalking.com"]);
    const kept = composeKeywordLockups(reel(), { speech: SPEECH, faces: FACES, keywords: ["Before", "yourself"], cta: { keyword: "free", caption: "try it at reelwalking.com today" } });
    expect(describeLockups(kept).find((l) => l.keyword === "free")!.layout).toBe("captions");
  });

  it("replaces companions when composed again, like the rest of the lockup", () => {
    const again = composeKeywordLockups(composed, { speech: SPEECH, faces: FACES, keywords: ["list", "thing"] });
    expect(describeLockups(again).map((l) => l.phrase)).toEqual(["Before you / list", "Ask yourself one / thing"]);
    expect(again.texts.filter((t) => t.lockup?.role === "companion").map((t) => t.text)).toEqual(["Before you", "Ask yourself one"]);
  });
});

describe("the companion role in the schema", () => {
  it("parses a saved companion and reads lockups saved before the addendum the same", () => {
    expect(textSchema.parse({ id: "c", text: "you list", startMs: 0, endMs: 900, lockup: { id: "x-0", role: "companion" } }).lockup!.role).toBe("companion");
    const before = textSchema.parse({ id: "k", text: "listing", startMs: 0, endMs: 900, lockup: { id: "x-0", role: "captions" } });
    expect(before.lockup!.role).toBe("captions");
  });
});
