import { describe, expect, it } from "vitest";
import { aiBoundary, aiShotFromClips, aiShotSchema, clipDurationMs, clipSchema, emptyTimeline, insertAiShot, parseTimeline } from "../src";

const a = clipSchema.parse({ id: "a", assetId: "real-a", kind: "VIDEO", sourceStartMs: 1000, sourceEndMs: 7000, speed: 2 });
const b = clipSchema.parse({ id: "b", assetId: "real-b", kind: "VIDEO", sourceStartMs: 2300, sourceEndMs: 5300, transitionIn: "whip" });
const ai = clipSchema.parse({ id: "insert-one", assetId: "generated", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 8000 });
const original = { ...emptyTimeline(), clips: [a, b] };

describe("footage anchored AI edits", () => {
  it("uses the displayed boundary of a trimmed, sped-up clip", () => {
    expect(aiBoundary(a, true)).toEqual({ assetId: "real-a", atMs: 6933 });
    expect(aiBoundary(b, false).atMs).toBe(2300);
  });
  it("requires both images for a bridge", () => {
    expect(aiShotSchema.safeParse({ mode: "bridge", first: aiBoundary(a, true) }).success).toBe(false);
    expect(aiShotSchema.safeParse({ mode: "gimbal" }).success).toBe(false);
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
    const photo = { ...a, kind: "IMAGE" as const, sourceStartMs: 0, sourceEndMs: 3500, speed: 1 };
    const timeline = { ...original, clips: [photo, b], cover: { clipId: photo.id, offsetMs: 1000 } };
    const next = insertAiShot(timeline, ai, aiShotFromClips("gimbal", photo));
    expect(next.clips[0].id).toBe(photo.id);
    expect(clipDurationMs(next.clips[0])).toBe(3500);
    expect(next.cover).toEqual(timeline.cover);
    expect(next.clips[1]).toEqual(b);
  });
});
