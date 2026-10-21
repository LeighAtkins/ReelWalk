import { describe, expect, it } from "vitest";
import { parseTimeline, type InstagramAudioTrack, type Timeline } from "@reelwalk/core";
import { createDocumentStore, STALE_PROPOSAL } from "./document-store";
import { landProposal, REJECTED_PROPOSAL, reviewGeneration } from "./proposals";

// How Ask and the director apply what comes back (the autopilot's use is in autopilot-flow.test.ts).

const reel = (ids: string[]): Timeline =>
  parseTimeline({ version: 1, clips: ids.map((id) => ({ id, assetId: id, kind: "IMAGE", sourceStartMs: 0, sourceEndMs: 3000 })), texts: [], music: null });
const track = { id: "ig1", title: "Song" } as InstagramAudioTrack;

function deps() {
  const store = createDocumentStore(reel(["a", "b"]));
  const fetched: string[] = [];
  return {
    store,
    fetched,
    deps: {
      ...store,
      fetchSound: async (pick: InstagramAudioTrack) => {
        fetched.push(pick.id);
        return { assetId: "song", sourceStartMs: 0, bpm: 120, beatOffsetMs: 0 };
      },
    },
  };
}

describe("Ask: applying the answer", () => {
  it("lands with its song in one undo step", async () => {
    const { store, deps: d } = deps();
    const base = store.snapshot();
    const landed = await landProposal(d, base.generation, reel(["b", "a"]), track);
    expect(landed.ok).toBe(true);
    expect(store.getState().history.present.music?.assetId).toBe("song");
    expect(store.getState().history.past).toHaveLength(1);
  });

  it("an answer that is not a valid reel fails with a message and changes nothing", async () => {
    const { store, deps: d } = deps();
    const landed = await landProposal(d, store.snapshot().generation, { version: 1, clips: [{ id: "x" }] }, null);
    expect(landed).toEqual({ ok: false, reason: "rejected", message: REJECTED_PROPOSAL });
    expect(store.getState().history.past).toHaveLength(0);
  });

  it("an answer for a reel that changed meanwhile is stale, and no song is fetched for it", async () => {
    const { store, fetched, deps: d } = deps();
    const base = store.snapshot();
    store.runCommand({ type: "moveClip", clipId: "b", toIndex: 0 });
    const landed = await landProposal(d, base.generation, reel(["a"]), track);
    expect(landed).toEqual({ ok: false, reason: "stale", message: STALE_PROPOSAL });
    expect(fetched).toEqual([]);
  });
});

describe("the director: applying a review", () => {
  it("a review asked in this session applies against its own generation", async () => {
    const { store, deps: d } = deps();
    const review = { generation: store.snapshot().generation, baseline: store.snapshot().timeline, timeline: reel(["b", "a"]) };
    const landed = await landProposal(d, reviewGeneration(store, review), review.timeline);
    expect(landed.ok && landed.timeline.clips.map((clip) => clip.id)).toEqual(["b", "a"]);
  });

  it("a review saved earlier applies only to the same edit", async () => {
    const { store, deps: d } = deps();
    expect(reviewGeneration(store, { baseline: reel(["a", "b"]) })).toBe(store.snapshot().generation);
    expect(reviewGeneration(store, { baseline: reel(["a"]) })).toBe(-1);
    const landed = await landProposal(d, reviewGeneration(store, { baseline: reel(["a"]) }), reel(["b"]));
    expect(landed.ok).toBe(false);
  });

  it("a review whose edit is not a valid reel is rejected, not reported as applied", async () => {
    const { store, deps: d } = deps();
    const landed = await landProposal(d, store.snapshot().generation, { version: 1, clips: "nope" });
    expect(landed.ok).toBe(false);
    expect(!landed.ok && landed.reason).toBe("rejected");
    expect(store.getState().generation).toBe(0);
  });
});
