import { describe, expect, it } from "vitest";
import { alignLine, levenshtein, lineTrim, normaliseWords, TRIM_LEAD_MS, TRIM_TAIL_MS, wordsMatch, WRONG_WORDS_THRESHOLD } from "../src/take-trim";
import { transcriptSchema } from "../src/transcript";

/** Words with timings, 400 ms each from `startMs`, 100 ms apart. */
const heard = (text: string, startMs = 0) => text.split(" ").map((w, i) => ({ w, s: startMs + i * 500, e: startMs + i * 500 + 400 }));

describe("auto-trim to the line (ADR 0069)", () => {
  it("normalises words and forgives a letter of spelling drift", () => {
    expect(normaliseWords("Cosy. It's small!")).toEqual(["cosy", "its", "small"]);
    expect(normaliseWords("Untouched since 1974.")).toEqual(["untouched", "since", "1974"]);
    expect(levenshtein("cosy", "cozy")).toBe(1);
    expect(wordsMatch("cosy", "cozy")).toBe(true);
    expect(wordsMatch("listings", "listing")).toBe(true);
    expect(wordsMatch("a", "the")).toBe(false);
    expect(wordsMatch("skip", "ship")).toBe(true);
    expect(wordsMatch("small", "smell")).toBe(true);
    expect(wordsMatch("doors", "walls")).toBe(false);
  });

  it("trims to the line with a 150 ms lead and a 250 ms tail, inside the file", () => {
    const words = heard("Cosy. It's small.", 600);
    const trim = lineTrim({ words }, "Cosy. It's small.", 4000);
    expect(trim).toEqual({ line: "Cosy. It's small.", startMs: 600 - TRIM_LEAD_MS, endMs: 1600 + 400 + TRIM_TAIL_MS, heard: "Cosy. It's small.", distance: 0, wrongWords: false });
    // The lead never goes before the file starts; the tail never past its end.
    expect(lineTrim({ words: heard("Send it.") }, "Send it.", 1000)).toMatchObject({ startMs: 0, endMs: 1000 });
  });

  it("drops the garbled tail Veo added after the line (take B of the villa reel)", () => {
    const words = heard("Send it, settle it, tune back into Hiker's List.");
    const trim = lineTrim({ words }, "Send it, settle it.", 4000);
    // "it" (the fourth word) ends at 1900 ms.
    expect(trim.endMs).toBe(1900 + TRIM_TAIL_MS);
    expect(trim.heard).toBe("Send it, settle it,");
    expect(trim.wrongWords).toBe(false);
  });

  it("skips a pause before she speaks (take L5) and spelling the recogniser chose (cozy)", () => {
    const trim = lineTrim({ words: heard("Needs a little TLC? Bring a skip?", 980) }, "Needs a little TLC. Bring a skip.", 4000);
    expect(trim.startMs).toBe(980 - TRIM_LEAD_MS);
    expect(trim.wrongWords).toBe(false);
    expect(lineTrim({ words: heard("cozy. It's small.") }, "Cosy. It's small.", 4000).wrongWords).toBe(false);
  });

  it("flags wrong words past the threshold, and a take with nothing heard", () => {
    const trim = lineTrim({ words: heard("Full of character, built in nineteen seventy four.") }, "Full of character. Untouched since 1974.", 4000);
    expect(trim.distance).toBeGreaterThan(WRONG_WORDS_THRESHOLD);
    expect(trim.wrongWords).toBe(true);
    expect(lineTrim({ words: heard("Welcome to the villa.") }, "Message me for a private tour.", 4000)).toMatchObject({ wrongWords: true });
    expect(lineTrim(null, "Welcome home.", 4000)).toEqual({ line: "Welcome home.", startMs: 0, endMs: 4000, heard: "", distance: 1, wrongWords: true });
    // One word in seven off is still her line.
    expect(lineTrim({ words: heard("If house listings were honest, this is what they would say.") }, "If house listings were honest, this is what they'd say.", 4000).wrongWords).toBe(false);
  });

  it("aligns inside a longer transcript, free at both ends", () => {
    const alignment = alignLine(normaliseWords("send it settle it"), normaliseWords("um send it settle it tune back in"));
    expect(alignment).toEqual({ first: 1, last: 4, matched: 4, distance: 0 });
    expect(alignLine([], ["a"])).toBeNull();
    expect(alignLine(["a"], [])).toBeNull();
  });

  it("is stored on the asset's transcript as `take`, additively", () => {
    const stored = transcriptSchema.parse({ text: "Send it.", words: heard("Send it."), take: lineTrim({ words: heard("Send it.") }, "Send it.", 4000) });
    expect(stored.take?.endMs).toBe(900 + TRIM_TAIL_MS);
    expect(transcriptSchema.parse({ text: "x", words: [] }).take).toBeUndefined();
  });
});
