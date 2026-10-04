import { describe, expect, it } from "vitest";
import {
  addClips,
  buildReelExportPayload,
  parseReelExportPayload,
  addText,
  clipDurationMs,
  clipStartsMs,
  DEFAULT_PANO,
  duplicateClip,
  emptyTimeline,
  framePlan,
  isEquirect,
  locate,
  MIN_CLIP_MS,
  moveClip,
  parseTimeline,
  referencedAssetIds,
  removeClip,
  setMusic,
  splitAt,
  textsAt,
  timelineDurationMs,
  trimClip,
  updateClip,
  updateText,
  type Clip,
  type Timeline,
} from "../src";

function video(id: string, sourceStartMs: number, sourceEndMs: number, speed = 1): Clip {
  return {
    id,
    assetId: `asset-${id}`,
    kind: "VIDEO",
    sourceStartMs,
    sourceEndMs,
    speed,
    volume: 1,
    fit: "cover",
    filter: "none",
    motion: "none",
    transitionIn: "cut",
    pano: null,
    spot: null,
    room: null,
  };
}

function photo(id: string, durationMs: number): Clip {
  return { ...video(id, 0, durationMs), kind: "IMAGE" };
}

function reel(...clips: Clip[]): Timeline {
  return addClips(emptyTimeline(), clips);
}

const text = { id: "t1", text: "Just listed", startMs: 0, x: 0.5, y: 0.4, style: "plain" as const, color: "#ffffff", size: 1 };

describe("durations", () => {
  it("divides the source window by the speed for video", () => {
    expect(clipDurationMs(video("a", 1000, 5000))).toBe(4000);
    expect(clipDurationMs(video("a", 1000, 5000, 2))).toBe(2000);
    expect(clipDurationMs(video("a", 0, 3000, 0.5))).toBe(6000);
  });

  it("ignores speed for photos", () => {
    expect(clipDurationMs({ ...photo("p", 3000), speed: 2 })).toBe(3000);
  });

  it("adds clips back to back", () => {
    const timeline = reel(video("a", 0, 4000), photo("b", 3000), video("c", 0, 2000, 2));
    expect(timelineDurationMs(timeline)).toBe(8000);
    expect(clipStartsMs(timeline)).toEqual([0, 4000, 7000]);
  });

  it("locates the clip under the playhead", () => {
    const timeline = reel(video("a", 0, 4000), photo("b", 3000));
    expect(locate(timeline, 0)).toEqual({ index: 0, offsetMs: 0 });
    expect(locate(timeline, 4000)).toEqual({ index: 1, offsetMs: 0 });
    expect(locate(timeline, 6999)).toEqual({ index: 1, offsetMs: 2999 });
    expect(locate(timeline, 7000)).toBeNull();
  });
});

describe("framePlan", () => {
  it("leaves no gaps or overlaps when durations do not divide into frames", () => {
    // 1/3 s clips at 30 fps are 10 frames each; 333 ms ones would drift if rounded one by one.
    const timeline = reel(photo("a", 1333), photo("b", 1333), photo("c", 1334));
    const plan = framePlan(timeline, 30);
    for (let index = 1; index < plan.clips.length; index++) {
      const previous = plan.clips[index - 1];
      expect(plan.clips[index].from).toBe(previous.from + previous.durationInFrames);
    }
    const last = plan.clips[plan.clips.length - 1];
    expect(last.from + last.durationInFrames).toBe(plan.totalFrames);
    expect(plan.totalFrames).toBe(120);
  });

  it("drops text that falls after the end", () => {
    const timeline: Timeline = { ...reel(photo("a", 2000)), texts: [{ ...text, startMs: 2500, endMs: 3000 }] };
    expect(framePlan(timeline, 30).texts).toHaveLength(0);
  });
});

describe("splitAt", () => {
  it("splits a clip at the playhead in source time", () => {
    const timeline = splitAt(reel(video("a", 1000, 7000, 2)), 1500, "b");
    expect(timeline.clips.map((clip) => [clip.id, clip.sourceStartMs, clip.sourceEndMs])).toEqual([
      ["a", 1000, 4000],
      ["b", 4000, 7000],
    ]);
    expect(timelineDurationMs(timeline)).toBe(3000);
  });

  it("refuses a cut that leaves a sliver", () => {
    const timeline = reel(video("a", 0, 4000));
    expect(splitAt(timeline, MIN_CLIP_MS - 1, "b")).toBe(timeline);
    expect(splitAt(timeline, 4000 - MIN_CLIP_MS + 1, "b")).toBe(timeline);
    expect(splitAt(timeline, 9000, "b")).toBe(timeline);
  });

  it("does not copy the transition onto the second piece", () => {
    const timeline = splitAt(reel({ ...video("a", 0, 4000), transitionIn: "fade" }), 2000, "b");
    expect(timeline.clips[1].transitionIn).toBe("cut");
  });
});

describe("trimClip", () => {
  it("clamps a video to its source length", () => {
    const timeline = trimClip(reel(video("a", 0, 4000)), "a", { sourceStartMs: -500, sourceEndMs: 99_000 }, 10_000);
    expect(timeline.clips[0]).toMatchObject({ sourceStartMs: 0, sourceEndMs: 10_000 });
  });

  it("keeps at least the minimum clip length", () => {
    const timeline = trimClip(reel(video("a", 0, 4000)), "a", { sourceStartMs: 3900, sourceEndMs: 3950 }, 4000);
    expect(clipDurationMs(timeline.clips[0])).toBeGreaterThanOrEqual(MIN_CLIP_MS);
    expect(timeline.clips[0].sourceEndMs).toBeLessThanOrEqual(4000);
  });

  it("lets a photo be any length", () => {
    const timeline = trimClip(reel(photo("p", 3000)), "p", { sourceStartMs: 0, sourceEndMs: 8000 });
    expect(clipDurationMs(timeline.clips[0])).toBe(8000);
  });

  it("pulls text back inside a shorter reel", () => {
    const start: Timeline = { ...reel(video("a", 0, 10_000)), texts: [{ ...text, startMs: 2000, endMs: 9000 }] };
    const trimmed = trimClip(start, "a", { sourceStartMs: 0, sourceEndMs: 5000 }, 10_000);
    expect(trimmed.texts[0]).toMatchObject({ startMs: 2000, endMs: 5000 });
    const shorter = trimClip(start, "a", { sourceStartMs: 0, sourceEndMs: 1000 }, 10_000);
    expect(shorter.texts).toHaveLength(0);
  });
});

describe("clip list edits", () => {
  const timeline = reel(video("a", 0, 1000), video("b", 0, 1000), video("c", 0, 1000));

  it("moves a clip", () => {
    expect(moveClip(timeline, "c", 0).clips.map((clip) => clip.id)).toEqual(["c", "a", "b"]);
    expect(moveClip(timeline, "a", 99).clips.map((clip) => clip.id)).toEqual(["b", "c", "a"]);
  });

  it("duplicates next to the original", () => {
    expect(duplicateClip(timeline, "a", "a2").clips.map((clip) => clip.id)).toEqual(["a", "a2", "b", "c"]);
  });

  it("removes a clip", () => {
    expect(removeClip(timeline, "b").clips.map((clip) => clip.id)).toEqual(["a", "c"]);
  });

  it("validates settings", () => {
    expect(updateClip(timeline, "a", { speed: 2 }).clips[0].speed).toBe(2);
    expect(() => updateClip(timeline, "a", { speed: 10 })).toThrow();
  });
});

describe("text", () => {
  const base = reel(video("a", 0, 10_000));

  it("adds text for three seconds by default, inside the reel", () => {
    expect(addText(base, { ...text, startMs: 1000 }).texts[0]).toMatchObject({ startMs: 1000, endMs: 4000 });
    expect(addText(base, { ...text, startMs: 9000 }).texts[0]).toMatchObject({ startMs: 9000, endMs: 10_000 });
  });

  it("does not add text to an empty reel", () => {
    expect(addText(emptyTimeline(), text).texts).toHaveLength(0);
  });

  it("finds text on screen at a time", () => {
    const timeline = addText(base, { ...text, startMs: 1000 });
    expect(textsAt(timeline, 999)).toHaveLength(0);
    expect(textsAt(timeline, 1000)).toHaveLength(1);
    expect(textsAt(timeline, 4000)).toHaveLength(0);
  });

  it("keeps timing valid when edited", () => {
    const timeline = addText(base, text);
    expect(updateText(timeline, "t1", { startMs: 5000, endMs: 4000 }).texts[0]).toMatchObject({ startMs: 5000, endMs: 5100 });
    expect(updateText(timeline, "t1", { endMs: 50_000 }).texts[0].endMs).toBe(10_000);
  });
});

describe("parsing", () => {
  it("round-trips a full timeline and fills defaults", () => {
    const timeline = setMusic(addText(reel(video("a", 0, 5000), photo("b", 3000)), text), {
      assetId: "song",
      sourceStartMs: 0,
      volume: 0.5,
    });
    expect(parseTimeline(JSON.parse(JSON.stringify(timeline)))).toEqual(timeline);
    expect(parseTimeline({ version: 1, clips: [{ id: "x", assetId: "y", kind: "IMAGE", sourceStartMs: 0, sourceEndMs: 3000 }], texts: [], music: null }).clips[0]).toMatchObject({ speed: 1, fit: "cover" });
    expect(referencedAssetIds(timeline).sort()).toEqual(["asset-a", "asset-b", "song"]);
  });

  it("rejects malformed timelines", () => {
    expect(() => parseTimeline({ version: 2, clips: [], texts: [], music: null })).toThrow();
    expect(() => parseTimeline({ version: 1, clips: [video("a", 5000, 1000)], texts: [], music: null })).toThrow();
    expect(() => parseTimeline({ version: 1, clips: [], texts: [{ ...text, color: "red", endMs: 1 }], music: null })).toThrow();
  });
});

describe("reel export payload", () => {
  const timeline = setMusic(reel(photo("a", 3000)), { assetId: "song", sourceStartMs: 0, volume: 1 });
  const library = [
    { id: "asset-a", objectKey: "uploads/w/a.jpg", kind: "IMAGE" as const },
    { id: "song", objectKey: "uploads/w/song.mp3", kind: "AUDIO" as const },
    { id: "unused", objectKey: "uploads/w/x.mp4", kind: "VIDEO" as const },
  ];

  it("freezes the timeline with only the assets it uses", () => {
    const payload = buildReelExportPayload(timeline, library);
    expect(Object.keys(payload.assets).sort()).toEqual(["asset-a", "song"]);
    expect(parseReelExportPayload(JSON.parse(JSON.stringify(payload)))).toEqual(payload);
  });

  it("refuses a timeline that points at deleted media", () => {
    expect(() => buildReelExportPayload(timeline, library.slice(1))).toThrow(/no longer exists/);
    expect(() => parseReelExportPayload({ timeline, assets: {} })).toThrow(/missing 2/);
  });
});

describe("360 photos", () => {
  it("recognises equirectangular images by their 2:1 shape", () => {
    expect(isEquirect(4096, 2048)).toBe(true);
    expect(isEquirect(8192, 4096)).toBe(true);
    expect(isEquirect(1920, 1080)).toBe(false);
    expect(isEquirect(1000, 500)).toBe(false);
    expect(isEquirect(null, null)).toBe(false);
  });

  it("stores a camera sweep on a clip and survives a round trip", () => {
    const timeline = updateClip(reel(photo("p", 5000)), "p", { pano: { ...DEFAULT_PANO, yawEnd: 120 } });
    expect(parseTimeline(JSON.parse(JSON.stringify(timeline))).clips[0].pano).toEqual({ yawStart: -45, yawEnd: 120, pitch: 0, fov: 90 });
    expect(() => updateClip(timeline, "p", { pano: { ...DEFAULT_PANO, fov: 170 } })).toThrow();
  });

  it("reads timelines saved before 360 support", () => {
    const old = { version: 1, clips: [{ id: "x", assetId: "y", kind: "IMAGE", sourceStartMs: 0, sourceEndMs: 3000 }], texts: [], music: null };
    expect(parseTimeline(old).clips[0].pano).toBeNull();
  });
});
