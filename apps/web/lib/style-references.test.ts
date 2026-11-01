import { describe, expect, it } from "vitest";
import { NAMED_EFFECTS, referenceAnalysisSchema } from "@reelwalk/core";
import { mediaScope } from "./media-scope";
import { REFERENCE_READ_INSTRUCTIONS, referenceReadInput } from "./reference-read";
import { cleanSourceUrl, referenceReadRequestId, referenceView } from "./style-references";

// Style references (ADR 0102): the link is a note only, the view tolerates whatever is stored, the reading prompt
// offers every effect the recipe accepts, and a reference's video is out of every media query.

describe("cleanSourceUrl", () => {
  it("keeps http(s) links and nothing else", () => {
    expect(cleanSourceUrl(" https://www.instagram.com/reel/DfKG598vnOk/?exln=x ")).toBe("https://www.instagram.com/reel/DfKG598vnOk/?exln=x");
    expect(cleanSourceUrl("javascript:alert(1)")).toBeNull();
    expect(cleanSourceUrl("not a link")).toBeNull();
    expect(cleanSourceUrl(42)).toBeNull();
    expect(cleanSourceUrl(`https://example.com/${"a".repeat(600)}`)!.length).toBe(500);
  });
});

describe("referenceView", () => {
  const row = { id: "r1", title: "16 ways", sourceUrl: null, error: null, createdAt: new Date("2026-11-01T00:00:00Z"), mediaAsset: { durationMs: 13_775, thumbKey: null } };
  it("summarises a stored recipe and lists its gaps", () => {
    const recipe = {
      version: 1, durationMs: 13_775, shots: [{ startMs: 0, endMs: 13_775 }],
      pacing: { shotCount: 1, medianShotMs: 13_775, meanShotMs: 13_775, cutsPerSecond: 0, firstCutMs: null }, speech: null, beat: null,
      titles: [{ text: "slam.", startMs: 5300, endMs: 7100, effect: "oneBigSlam" }], notes: [],
    };
    const view = referenceView({ ...row, status: "ready", recipe });
    expect(view.status).toBe("ready");
    expect(view.summary).toContain("13.8 s, 1 shot, one continuous shot.");
    expect(view.gaps.map((g) => g.effect)).toEqual(["oneBigSlam"]);
  });
  it("shows an unreadable recipe as none and an unknown status as failed", () => {
    const view = referenceView({ ...row, status: "weird", recipe: { version: 2 } });
    expect(view).toMatchObject({ status: "failed", recipe: null, summary: null, gaps: [] });
  });
  it("reads each reference once per reader version", () => {
    expect(referenceReadRequestId("r1")).toBe("reference-read:r1:v1");
  });
});

describe("the reading prompt", () => {
  it("names every effect the recipe accepts", () => {
    for (const effect of NAMED_EFFECTS) expect(REFERENCE_READ_INSTRUCTIONS).toContain(effect);
    expect(REFERENCE_READ_INSTRUCTIONS).toContain("maskUp");
  });
  it("labels the keyframes in the order the images are sent, with the measurements", () => {
    const analysis = referenceAnalysisSchema.parse({
      version: 1, durationMs: 13_775, width: 1080, height: 1920, shots: [{ startMs: 0, endMs: 1800, motion: 0.02 }, { startMs: 1800, endMs: 13_775 }],
      beat: null, words: [{ text: "Instead", startMs: 0, endMs: 300 }], keyframes: [],
    });
    const input = referenceReadInput(analysis, [{ atMs: 0, dataUrl: "" }, { atMs: 250, dataUrl: "" }]);
    expect(input).toContain("Shots (measured cuts): 1: 0-1800 ms, motion 0.02; 2: 1800-13775 ms.");
    expect(input).toContain("Transcript (word@ms): Instead@0");
    expect(input).toContain("Keyframes, in the order of the images: #1 at 0 ms, #2 at 250 ms.");
  });
});

describe("mediaScope", () => {
  it("leaves out style reference videos", () => {
    expect(mediaScope("ws1")).toEqual({ OR: [{ workspaceId: "ws1" }, { shared: true }], styleReference: { is: null } });
  });
});
