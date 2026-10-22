import { describe, expect, it } from "vitest";
import { clipDurationMs, clipStartsMs, parseTimeline, timelineDurationMs, type Timeline } from "../src/timeline";
import {
  STORY_END_CARD_CLIP_ID,
  STORY_END_CARD_MS,
  STORY_HOOK_MAX_MS,
  STORY_HOOK_MIN_MS,
  STORY_HOOK_TARGET_MS,
  fullReelStoryProblem,
  planStoryCut,
  storyEndCardText,
  storyHookMs,
} from "../src/stories";

/** A reel of `lengthsMs` shots back to back: videos at 1x from 1 s in, with a few titles over the opening. */
function reel(lengthsMs: number[], extra: Partial<Record<keyof Timeline, unknown>> = {}): Timeline {
  return parseTimeline({
    version: 1,
    clips: lengthsMs.map((ms, i) =>
      i % 2 === 0
        ? { id: `c${i + 1}`, assetId: `video${i + 1}`, kind: "VIDEO", sourceStartMs: 1000, sourceEndMs: 1000 + ms, room: "kitchen" }
        : { id: `c${i + 1}`, assetId: `photo${i + 1}`, kind: "IMAGE", sourceStartMs: 0, sourceEndMs: ms, motion: "zoom-in" },
    ),
    texts: [
      { id: "t-open", text: "The view you wake up to", startMs: 200, endMs: 3500, style: "elegant", font: "serif" },
      { id: "t-mid", text: "Chef's kitchen", startMs: 7000, endMs: 11_000, style: "elegant" },
      { id: "t-late", text: "Viewings Saturday", startMs: 20_000, endMs: 23_000, style: "elegant" },
    ],
    music: { assetId: "song", bpm: 120, beatOffsetMs: 0 },
    details: { price: "$2.4M", address: "12 Hill Rd", placement: "end" },
    ...extra,
  });
}

describe("storyHookMs", () => {
  it("keeps the whole reel when it is no longer than the upper bound", () => {
    expect(storyHookMs(reel([4000, 5000]))).toBe(9000);
    expect(storyHookMs(reel([12_000]))).toBe(STORY_HOOK_MAX_MS);
  });

  it("ends on the last cut between the bounds", () => {
    // Cuts at 3, 6, 9 and 11.5 s: 11.5 s is the last inside 8–12.
    expect(storyHookMs(reel([3000, 3000, 3000, 2500, 8000]))).toBe(11_500);
    // Cuts at 5 and 9 s: 9 s.
    expect(storyHookMs(reel([5000, 4000, 10_000]))).toBe(9000);
  });

  it("cuts at the target when no shot ends between the bounds", () => {
    expect(storyHookMs(reel([7000, 7000, 7000]))).toBe(STORY_HOOK_TARGET_MS);
    expect(STORY_HOOK_TARGET_MS).toBeGreaterThanOrEqual(STORY_HOOK_MIN_MS);
    expect(STORY_HOOK_TARGET_MS).toBeLessThanOrEqual(STORY_HOOK_MAX_MS);
  });
});

describe("planStoryCut", () => {
  it("is the opening on a cut, titles clipped to it, then a two-second plate", () => {
    const { timeline, hookMs, totalMs } = planStoryCut(reel([5000, 4000, 10_000]), { handle: "reelwalking" });
    expect(hookMs).toBe(9000);
    expect(totalMs).toBe(9000 + STORY_END_CARD_MS);
    expect(timeline.clips.map((clip) => clip.id)).toEqual(["c1", "c2", STORY_END_CARD_CLIP_ID]);
    // Titles: the opening stays, the mid one is clipped to the cut, the late one is gone.
    expect(timeline.texts.map((text) => [text.id, text.startMs, text.endMs])).toEqual([
      ["t-open", 200, 3500],
      ["t-mid", 7000, 9000],
    ]);
    expect(timeline.endCard).toEqual({ text: "new reel · @reelwalking", durationMs: STORY_END_CARD_MS });
    // The plate's footage is the last kept shot again, silent, faded in; a photo plays from its start.
    const plate = timeline.clips[2];
    expect(plate).toMatchObject({ assetId: "photo2", kind: "IMAGE", sourceStartMs: 0, sourceEndMs: STORY_END_CARD_MS, volume: 0, transitionIn: "fade" });
    expect(clipStartsMs(timeline)[2]).toBe(hookMs);
    // The plate is the ending: the facts card no longer closes the reel; the music is kept.
    expect(timeline.details?.placement).toBe("none");
    expect(timeline.music?.assetId).toBe("song");
  });

  it("trims the shot the cut falls in, in source time at the shot's speed", () => {
    const source = reel([7000, 7000, 7000]);
    source.clips[1] = { ...source.clips[1], kind: "VIDEO", assetId: "video2", sourceStartMs: 2000, sourceEndMs: 16_000, speed: 2 };
    const { timeline, hookMs } = planStoryCut(parseTimeline(source), { handle: "@reelwalking" });
    expect(hookMs).toBe(STORY_HOOK_TARGET_MS);
    // 3 s of a 2x shot is 6 s of source.
    expect(timeline.clips[1]).toMatchObject({ id: "c2", sourceStartMs: 2000, sourceEndMs: 8000, speed: 2 });
    expect(clipDurationMs(timeline.clips[1])).toBe(3000);
    // A video plate uses the last two seconds the shot already plays, never past them.
    const plate = timeline.clips[2];
    expect(plate).toMatchObject({ assetId: "video2", sourceStartMs: 4000, sourceEndMs: 8000, speed: 2, volume: 0 });
    expect(timeline.endCard).toEqual({ text: "new reel · @reelwalking", durationMs: STORY_END_CARD_MS });
  });

  it("prefers a cut just inside the bounds to a mid-shot cut at the target", () => {
    // Cuts at 4.9, 9.8 and 14 s: 9.8 s is an edit the studio made, 10 s would leave 200 ms of the third shot.
    const { timeline, hookMs } = planStoryCut(reel([4900, 4900, 4200, 6000]), { handle: "reelwalking" });
    expect(hookMs).toBe(9800);
    expect(timeline.clips.map((clip) => clip.id)).toEqual(["c1", "c2", STORY_END_CARD_CLIP_ID]);
  });

  it("keeps a short reel whole, with the plate after it", () => {
    const { timeline, hookMs, totalMs } = planStoryCut(reel([3000, 3000]), { handle: "reelwalking" });
    expect(hookMs).toBe(6000);
    expect(totalMs).toBe(8000);
    expect(timeline.texts.map((text) => text.id)).toEqual(["t-open"]);
  });

  it("keeps a facts card at the start, drops its cover when the cover's shot is cut, and still parses", () => {
    const source = reel([5000, 4000, 10_000], { details: { price: "$2.4M", placement: "both" }, cover: { clipId: "c3", offsetMs: 500 } });
    const { timeline } = planStoryCut(source, { handle: "reelwalking" });
    expect(timeline.details?.placement).toBe("start");
    expect(timeline.cover).toBeNull();
    expect(() => parseTimeline(timeline)).not.toThrow();
    expect(timelineDurationMs(timeline)).toBe(11_000);
  });

  it("refuses a reel with no shots", () => {
    expect(() => planStoryCut(reel([]), { handle: "x" })).toThrow(/no shots/);
  });
});

describe("story limits", () => {
  it("names the plate after the account", () => {
    expect(storyEndCardText("reelwalking")).toBe("new reel · @reelwalking");
    expect(storyEndCardText("@reelwalking ")).toBe("new reel · @reelwalking");
    expect(storyEndCardText("")).toBe("new reel");
  });

  it("allows the full reel as a story only within Instagram's limits", () => {
    expect(fullReelStoryProblem(30_000)).toBeNull();
    expect(fullReelStoryProblem(60_000)).toBeNull();
    expect(fullReelStoryProblem(61_000)).toMatch(/up to 60 s/);
    expect(fullReelStoryProblem(2000)).toMatch(/at least 3 s/);
    expect(fullReelStoryProblem(30_000, 101 * 1024 * 1024)).toMatch(/100 MB/);
  });
});
