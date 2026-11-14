import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CameraKeyframeInput, CameraKeyframeJob } from "@reelwalk/core";
import { keyframeInputKey, keyframeMatches, ShotKeyframePanel } from "./shot-keyframe-panel";

const input: CameraKeyframeInput = { role: "end", source: { assetId: "original", atMs: 0 }, continuity: { assetId: "start", atMs: 0 }, move: "shift-right", distanceM: 3, durationSeconds: 4 };
const job = { input, id: "paid-candidate" } as CameraKeyframeJob;
describe("keyframe review identity", () => {
  it("accepts only the same source, continuity, direction, distance, duration and words", () => {
    expect(keyframeMatches(job, { ...input })).toBe(true);
    const variants: CameraKeyframeInput[] = [
      { ...input, role: "start" }, { ...input, source: { assetId: "different-photo", atMs: 0 } },
      { ...input, continuity: { assetId: "changed-start", atMs: 0 } }, { ...input, move: "shift-left" },
      { ...input, distanceM: 2 }, { ...input, durationSeconds: 8 }, { ...input, prompt: "Make it dusk" },
    ];
    for (const changed of variants) expect(keyframeMatches(job, changed)).toBe(false);
    expect(keyframeMatches(job, null)).toBe(false);
  });
  it("normalizes optional whitespace without changing a real instruction", () => {
    expect(keyframeInputKey(input)).toBe(keyframeInputKey({ ...input, prompt: "  " }));
    expect(keyframeInputKey({ ...input, prompt: "dusk" })).toBe(keyframeInputKey({ ...input, prompt: " dusk " }));
  });
  it("never enables paid generation before saved history is reconciled", () => {
    const html = renderToStaticMarkup(createElement(ShotKeyframePanel, { role: "end", input, recoveryKey: "reel", onAssets() {}, onBalance() {}, onUse() {}, onKeepSource() {}, onBlocked() {} }));
    expect(html).toContain("Generate End image");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Generate End image/);
    expect(html).not.toContain("Use this End");
    expect(html).not.toContain("<video");
  });
});
