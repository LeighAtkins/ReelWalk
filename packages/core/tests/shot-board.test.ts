import { describe, expect, it } from "vitest";
import { clipSchema, textSchema, musicSchema, emptyTimeline, parseTimeline, referencedAssetIds, timelineDurationMs } from "../src/timeline";
import { insertShotCard, moveShotCard, placeShotAsset, placeShotTake, removeShotCard, saveShotCards, shotCards, updateShotCard } from "../src/shot-board";
const take = clipSchema.parse({ id: "take", assetId: "owned-take", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 4000 });
function reserved() {
  let t = emptyTimeline();
  for (const id of ["left", "middle", "right"]) t = insertShotCard(t, id);
  return updateShotCard(t, "middle", c => ({ ...c, draft: "approved", request: { id: "request", draft: "approved", jobId: "job" } }));
}
describe("durable shot reservations", () => {
  it("places an explicit library take in the chosen card, refusing a deleted destination", () => {
    const t = moveShotCard(reserved(), "middle", -1);
    const placed = placeShotAsset(t, "middle", take);
    expect(shotCards(placed)[0].clipId).toBe(take.id);
    const removed = removeShotCard(t, "middle");
    expect(placeShotAsset(removed, "middle", take)).toBe(removed);
  });
  it("round trips blank cards without creating playable clips or touching old reels", () => {
    const old = emptyTimeline(); expect(parseTimeline(JSON.parse(JSON.stringify(old)))).toEqual(old);
    expect(old).not.toHaveProperty("shotBoard");
    const board = reserved(), restored = parseTimeline(JSON.parse(JSON.stringify(board)));
    expect(restored).toEqual(board); expect(restored.clips).toEqual([]); expect(timelineDurationMs(restored)).toBe(0);
  });
  it("retains frozen submission inputs across timeline save and reload", () => {
    const payload = JSON.stringify({ prompt: "The original requested camera move", shot: { mode: "custom" }, durationSeconds: 4 });
    const board = updateShotCard(reserved(), "middle", card => ({ ...card, request: { ...card.request!, payload } }));
    expect(shotCards(parseTimeline(JSON.parse(JSON.stringify(board))))[1].request?.payload).toBe(payload);
  });
  it("lands exactly once in its current slot after a neighbouring move and reload, preserving four seconds", () => {
    let t = reserved();
    const left = { ...take, id: "left-clip" }, right = { ...take, id: "right-clip" };
    t = saveShotCards({ ...t, clips: [left, right] }, shotCards(t).map(c => c.id === "left" ? { ...c, clipId: left.id } : c.id === "right" ? { ...c, clipId: right.id } : c));
    t = moveShotCard(t, "right", -2);
    t = parseTimeline(JSON.parse(JSON.stringify(t)));
    const placed = placeShotTake(t, "middle", "job", take);
    expect(shotCards(placed).map(c => c.id)).toEqual(["right", "left", "middle"]);
    expect(placed.clips.map(c => c.id)).toEqual(["right-clip", "left-clip", "take"]);
    expect(placed.clips[2].sourceEndMs).toBe(4000);
    expect(placeShotTake(placed, "middle", "job", take)).toBe(placed);
  });
  it("refuses deleted, replaced, unknown and mismatched requests without appending elsewhere", () => {
    const t = reserved(), removed = removeShotCard(t, "middle");
    expect(placeShotTake(removed, "middle", "job", take)).toBe(removed);
    const changed = updateShotCard(t, "middle", c => ({ ...c, draft: "changed" }));
    expect(placeShotTake(changed, "middle", "job", take)).toBe(changed);
    expect(placeShotTake(t, "middle", "other-job", take)).toBe(t);
    const unknown = updateShotCard(t, "middle", c => ({ ...c, request: { id: "unknown", draft: "approved" } }));
    expect(placeShotTake(unknown, "middle", "job", take)).toBe(unknown);
  });
  it("follows existing clip removals and moves while keeping typography and audio unchanged", () => {
    const a = { ...take, id: "a" }, b = { ...take, id: "b" };
    const base = { ...emptyTimeline(), clips: [a, b],
      texts: [textSchema.parse({ id: "approved-title", text: "Made in ReelWalk", startMs: 0, endMs: 4000, x: 0.5, y: 0.4, style: "elegant", color: "#ffffff", size: 1, animation: "none" })],
      music: musicSchema.parse({ assetId: "approved-audio", volume: 0.4, startMs: 0 }) };
    const t = saveShotCards(base, shotCards(base));
    expect(shotCards({ ...t, clips: [b, a] }).map(c => c.clipId)).toEqual(["b", "a"]);
    expect(shotCards({ ...t, clips: [b] }).map(c => c.clipId)).toEqual(["b"]);
    const moved = moveShotCard(t, "clip-a", 1);
    expect(moved.texts[0]).toMatchObject({ id: "approved-title", text: "Made in ReelWalk", style: "elegant", color: "#ffffff", animation: "none" }); expect(moved.music).toBe(t.music);
    expect(removeShotCard(moved, "clip-b").clips.map(c => c.id)).toEqual(["a"]);
  });
  it("exposes every source and approved frame to the existing ownership validation", () => {
    const t = updateShotCard(reserved(), "middle", c => ({ ...c, sourceAssetId: "foreign", frameAssetIds: ["start", "end"] }));
    expect(referencedAssetIds(t)).toEqual(["foreign", "start", "end"]);
  });
});
