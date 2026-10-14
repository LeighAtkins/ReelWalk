import { describe, expect, it } from "vitest";
import { applyAiEditPlan, fakeAiEditPlan, type AiAsset, type AiEditOp } from "../src/ai-edit";
import { parseTimeline, type Timeline } from "../src/timeline";

// Turning a 360 photo by asking (ADR 0025): "face the door", "do a full spin".

const assets: Record<string, AiAsset> = {
  p: { id: "p", kind: "IMAGE", title: "bedroom (360)", durationMs: null, isPano: true, bpm: null, beatOffsetMs: null, room: "bedroom" },
  k: { id: "k", kind: "IMAGE", title: "kitchen", durationMs: null, isPano: false, bpm: null, beatOffsetMs: null, room: "kitchen" },
};

function reel(): Timeline {
  return parseTimeline({
    version: 1,
    clips: [
      { id: "c1", assetId: "p", kind: "IMAGE", sourceStartMs: 0, sourceEndMs: 5000, pano: { yawStart: -45, yawEnd: 45, pitch: 0, fov: 90 }, room: "bedroom" },
      { id: "c2", assetId: "k", kind: "IMAGE", sourceStartMs: 0, sourceEndMs: 3000, room: "kitchen" },
    ],
    texts: [],
    music: null,
  });
}

const blank: Omit<AiEditOp, "op"> = {
  clip: null, text: null, startMs: null, endMs: null, lengthMs: null, speed: null, filter: null, motion: null, transition: null, fit: null,
  volume: null, toPosition: null, content: null, style: null, color: null, size: null, y: null, songId: null, on: null, details: null,
  assetId: null, order: null, pieces: null, atClip: null, animation: null, zoom: null, corner: null, yaw: null, sweep: null,
};
const op = (fields: Partial<AiEditOp> & { op: AiEditOp["op"] }): AiEditOp => ({ ...blank, ...fields });
const run = (ops: AiEditOp[]) => applyAiEditPlan(reel(), { ops, note: "" }, { assets, songs: [], newId: () => "n" });

describe("turning a 360 photo", () => {
  it("ends the sweep on the thing to face, keeping the sweep it had", () => {
    const { timeline, applied } = run([op({ op: "turn", clip: 1, content: "the door", yaw: 120 })]);
    expect(timeline.clips[0].pano).toMatchObject({ yawStart: 30, yawEnd: 120 });
    expect(applied).toEqual(["clip 1 (bedroom): turns 90° to face the door"]);
  });

  it("a full spin, or holding still", () => {
    expect(run([op({ op: "turn", clip: 1, yaw: 45, sweep: 360 })]).timeline.clips[0].pano).toMatchObject({ yawStart: -315, yawEnd: 45 });
    expect(run([op({ op: "turn", clip: 1, yaw: 0, sweep: 0 })]).timeline.clips[0].pano).toMatchObject({ yawStart: 0, yawEnd: 0 });
    expect(run([op({ op: "turn", clip: 1, yaw: 45, sweep: -90 })]).timeline.clips[0].pano).toMatchObject({ yawStart: 135, yawEnd: 45 });
  });

  it("a sweep alone keeps the direction the shot ends on", () => {
    expect(run([op({ op: "turn", clip: 1, sweep: 360 })])).toMatchObject({ applied: ["clip 1 (bedroom): turns 360° clockwise"] });
    expect(run([op({ op: "turn", clip: 1, sweep: 360 })]).timeline.clips[0].pano).toMatchObject({ yawStart: -315, yawEnd: 45 });
    expect(run([op({ op: "turn", clip: 1, sweep: -90 })]).timeline.clips[0].pano).toMatchObject({ yawStart: 135, yawEnd: 45 });
    expect(run([op({ op: "turn", clip: 1, sweep: 0 })]).applied).toEqual(["clip 1 (bedroom): holds still"]);
  });

  it("says when the thing was not found, or the clip is not a 360 photo", () => {
    expect(run([op({ op: "turn", clip: 1, content: "the pool" })]).skipped).toEqual(["turn: could not find the pool in clip 1 (bedroom)"]);
    expect(run([op({ op: "turn", clip: 2, content: "the door", yaw: 10 })]).skipped).toEqual(["turn: clip 2 (kitchen) is not a 360 photo"]);
  });

  it("the stand-in turns the first 360 shot", () => {
    expect(fakeAiEditPlan("face the door", reel(), []).ops[0]).toMatchObject({ op: "turn", clip: 1, content: "door", yaw: 90 });
    expect(fakeAiEditPlan("do a full spin", reel(), []).ops[0]).toMatchObject({ op: "turn", clip: 1, sweep: 360 });
  });
});
