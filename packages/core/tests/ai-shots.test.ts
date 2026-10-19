import { describe, expect, it } from "vitest";
import { aiBoundary, aiShotFromClips, aiShotSchema, aiShotPrompt, aiShotStyle, clipDurationMs, clipSchema, emptyTimeline, insertAiShot, parseTimeline, type AiShotMode } from "../src";

const a = clipSchema.parse({ id: "a", assetId: "real-a", kind: "VIDEO", sourceStartMs: 1000, sourceEndMs: 7000, speed: 2 });
const b = clipSchema.parse({ id: "b", assetId: "real-b", kind: "VIDEO", sourceStartMs: 2300, sourceEndMs: 5300, transitionIn: "whip" });
const ai = clipSchema.parse({ id: "insert-one", assetId: "generated", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 8000 });
const original = { ...emptyTimeline(), clips: [a, b] };

describe("footage anchored AI edits", () => {
  it("composes a start or end still only around a real frame", () => {
    const compose = { presenter: { assetId: "real-b", atMs: 2300 }, first: "In the open doorway, shoulder height to the door handle." };
    expect(aiShotSchema.safeParse({ mode: "custom", compose }).success).toBe(false);
    expect(aiShotSchema.safeParse({ mode: "custom", first: aiBoundary(a, true), compose: { ...compose, first: undefined, last: "Seated on the sofa." } }).success).toBe(false);
    expect(aiShotSchema.safeParse({ mode: "custom", first: aiBoundary(a, true), compose }).success).toBe(true);
  });
  it("requires before and after references for construction and keeps the whole build", () => {
    const missingEnd = { mode: "construction", first: aiBoundary(a, true) };
    expect(aiShotSchema.safeParse(missingEnd).success).toBe(false);
    const shot = aiShotSchema.parse(aiShotFromClips("construction", a, b));
    const next = insertAiShot(original, ai, shot);
    expect(next.clips.map(c => c.assetId)).toEqual(["real-a", "generated", "real-b"]);
    expect(clipDurationMs(next.clips[1])).toBe(8000);
    expect(aiShotPrompt(shot.mode, "Show the build", shot)).toContain("conceptual construction visualization");
  });
  it.each(["orbit", "fly-through", "day-night"] as AiShotMode[])("can animate a still with %s while preserving its timing", mode => {
    const photo = { ...a, kind: "IMAGE" as const, sourceStartMs: 0, sourceEndMs: 5000, speed: 1 };
    const timeline = { ...original, clips: [photo, b] };
    const next = insertAiShot(timeline, ai, aiShotFromClips(mode, photo));
    expect(next.clips).toHaveLength(2);
    expect(next.clips[0]).toMatchObject({ id: photo.id, kind: "VIDEO", assetId: "generated" });
    expect(clipDurationMs(next.clips[0])).toBe(5000);
  });
  it("composes camera, style, weather and energy without freezing a requested lighting change", () => {
    const shot = { ...aiShotFromClips("orbit", a), style: "neon" as const, atmosphere: "blue-hour" as const, energy: "bold" as const };
    const prompt = aiShotPrompt(shot.mode, "Circle clockwise", shot);
    expect(prompt).toContain("drone orbit");
    expect(prompt).toContain("cyan and magenta");
    expect(prompt).toContain("deep blue sky");
    expect(prompt).toContain("bold high-impact");
    expect(prompt).toContain("Circle clockwise");
    expect(prompt).not.toContain("Keep reference lighting unchanged");
    const dayNight = aiShotPrompt("day-night", "Hold the view", { ...shot, mode: "day-night", atmosphere: "sunny" });
    expect(dayNight).toContain("day-to-night lighting progression takes priority");
    expect(dayNight).not.toContain("soft sunshine");
    expect(dayNight).toContain("camera locked");
  });
  it("chooses a cohesive automatic direction and applies the optional grade to both kinds of footage", () => {
    const anchor = { ...a, room: "bedroom" };
    const shot = { ...aiShotFromClips("continue", anchor), style: "auto" as const, harmonize: true };
    expect(aiShotStyle(shot)).toBe("refined");
    const timeline = { ...original, clips: [anchor, b] };
    const next = insertAiShot(timeline, ai, shot);
    expect(next.clips.map(c => c.filter)).toEqual(["warm", "warm", "warm"]);
    expect(timeline.clips.map(c => c.filter)).toEqual(["none", "none"]);
    const ungraded = insertAiShot(timeline, ai, { ...shot, harmonize: false });
    expect(ungraded.clips.map(c => c.filter)).toEqual(["none", "none", "none"]);
  });
  it("keeps old recipes compatible and rejects unknown style choices", () => {
    expect(aiShotStyle(aiShotFromClips("continue", a))).toBe("source");
    expect(aiShotSchema.safeParse({ ...aiShotFromClips("continue", a), style: "unknown" }).success).toBe(false);
    const shot = aiShotFromClips("bridge", a, b);
    expect(aiShotPrompt(shot.mode, "Connect the rooms", shot)).toContain("ending frame's composition, geometry and lighting");
  });
  it("can polish typography and camera accents without overriding an unchecked colour grade", () => {
    const timeline = { ...original, clips: [{ ...a, filter: "cool" as const }, b] };
    const shot = { ...aiShotFromClips("continue", timeline.clips[0]), style: "refined" as const, harmonize: false, polish: true };
    const next = insertAiShot(timeline, ai, shot);
    expect(next.clips.map(c => c.filter)).toEqual(["cool", "cool", "none"]);
    expect(next.clips[0].motion).toBe("snap-out");
    expect(next.clips[0].lensSoftness).toBeGreaterThan(0);
  });
  it("uses the displayed boundary of a trimmed, sped-up clip", () => {
    expect(aiBoundary(a, true)).toEqual({ assetId: "real-a", atMs: 6933 });
    expect(aiBoundary(b, false).atMs).toBe(2300);
  });
  it("requires both images for a bridge", () => {
    expect(aiShotSchema.safeParse({ mode: "bridge", first: aiBoundary(a, true) }).success).toBe(false);
    expect(aiShotSchema.safeParse({ mode: "gimbal" }).success).toBe(false);
    expect(aiShotSchema.safeParse({ mode: "bridge", first: aiBoundary(a, true), last: aiBoundary(b, false), anchor: a }).success).toBe(false);
    expect(aiShotSchema.safeParse({ mode: "bridge", first: aiBoundary(a, true), last: aiBoundary(b, false) }).success).toBe(true);
  });
  it("keeps both bridge endpoints, real footage and following captions", () => {
    const timeline = { ...original, texts: [{ id: "caption", text: "Next room", startMs: 3000, endMs: 5000, x: 0.5, y: 0.5, size: 1, style: "plain" as const, color: "#ffffff", animation: "auto" as const }] };
    const next = insertAiShot(timeline, ai, aiShotFromClips("burst", a, b));
    expect(next.clips.map(c => c.assetId)).toEqual(["real-a", "generated", "real-b"]);
    expect(next.clips[1]).toMatchObject({ sourceStartMs: 0, sourceEndMs: 8000, speed: 4, volume: 0 });
    expect(clipDurationMs(next.clips[1])).toBe(2000);
    expect(next.clips[2].transitionIn).toBe("cut");
    expect(next.texts[0]).toMatchObject({ startMs: 5000, endMs: 7000 });
    expect(timeline.clips[1].transitionIn).toBe("whip");
    expect(parseTimeline(next)).toEqual(next);
  });
  it("refuses changed or moved boundaries, and ignores a repeated application", () => {
    const shot = aiShotFromClips("bridge", a, b);
    const edited = { ...original, clips: [{ ...a, sourceEndMs: 6500 }, b] };
    expect(insertAiShot(edited, ai, shot)).toBe(edited);
    const moved = { ...original, clips: [b, a] };
    expect(insertAiShot(moved, ai, shot)).toBe(moved);
    const done = insertAiShot(original, ai, shot);
    expect(insertAiShot(done, ai, shot)).toBe(done);
  });
  it("matches snapshots after Postgres JSONB changes object key ordering", () => {
    const reversed = Object.fromEntries(Object.entries(a).reverse());
    const shot = aiShotSchema.parse({ ...aiShotFromClips("bridge", a, b), anchor: reversed });
    expect(insertAiShot(original, ai, shot).clips).toHaveLength(3);
  });
  it("replaces a still without shifting its duration, cover or other shots", () => {
    const photo = { ...a, kind: "IMAGE" as const, sourceStartMs: 0, sourceEndMs: 3500, speed: 1, room: "living", spot: { x: 0.4, y: 0.5, heading: 30 } };
    const timeline = { ...original, clips: [photo, b], cover: { clipId: photo.id, offsetMs: 1000 } };
    const next = insertAiShot(timeline, ai, aiShotFromClips("gimbal", photo));
    expect(next.clips[0].id).toBe(photo.id);
    expect(clipDurationMs(next.clips[0])).toBe(3500);
    expect(next.cover).toEqual(timeline.cover);
    expect(next.clips[0].room).toBe("living");
    expect(next.clips[0].spot).toEqual(photo.spot);
    expect(next.clips[1]).toEqual(b);
  });
  it("plays a 4-second generation at natural speed for moves, half the burst and full length for custom shots", () => {
    const short = clipSchema.parse({ id: "insert-short", assetId: "generated", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 4000 });
    const a = clipSchema.parse({ id: "a", assetId: "real-a", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 3000 });
    const b = clipSchema.parse({ id: "b", assetId: "real-b", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 3000 });
    const timeline = parseTimeline({ ...emptyTimeline(), clips: [a, b] });
    expect(insertAiShot(timeline, short, aiShotFromClips("bridge", a, b)).clips[1]).toMatchObject({ sourceEndMs: 4000, speed: 1 });
    expect(insertAiShot(timeline, short, aiShotFromClips("burst", a, b)).clips[1]).toMatchObject({ sourceEndMs: 4000, speed: 2 });
    const custom = insertAiShot(timeline, short, { mode: "custom" });
    expect(clipDurationMs(custom.clips[2]!)).toBe(4000);
  });
});
