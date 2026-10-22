import { describe, expect, it } from "vitest";
import { brollFor, brollWindow, CUTAWAY_HOLD_MS, cutawaySpacing, isPresenterTake, planCutaways, removeCutaways } from "../src/cutaways";
import { applyCommand } from "../src/commands";
import { speechWindows } from "../src/ducking";
import { clipDurationMs, clipSchema, emptyTimeline, timelineDurationMs, timelineSchema, type Clip, type Timeline } from "../src/timeline";

const clip = (overrides: Partial<Clip> & { id: string; assetId: string }) => clipSchema.parse({ kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 4000, ...overrides });
const kitchen = clip({ id: "k", assetId: "kitchen", sourceStartMs: 2000, sourceEndMs: 8000, room: "kitchen" });
const pool = clip({ id: "p", assetId: "pool", sourceEndMs: 6000, room: "pool" });
const photo = clip({ id: "ph", assetId: "lounge-photo", kind: "IMAGE", sourceEndMs: 3000, room: "lounge" });
const take = clip({ id: "script-ai-take1", assetId: "ai-take1", sourceEndMs: 8000, volume: 1, room: "kitchen" });
const reel = (...clips: Clip[]): Timeline => ({ ...emptyTimeline(), clips, texts: [{ id: "t", text: "Hello", startMs: 15000, endMs: 17000, x: 0.5, y: 0.4, style: "plain", color: "#ffffff", size: 1, animation: "auto" }] });

describe("cutaways over a presenter line (ADR 0069)", () => {
  it("knows a presenter take: a generated clip with its own sound, never a cutaway piece", () => {
    expect(isPresenterTake(take)).toBe(true);
    expect(isPresenterTake({ ...take, volume: 0 })).toBe(false);
    expect(isPresenterTake(kitchen)).toBe(false);
    expect(isPresenterTake({ ...take, id: "script-ai-take1-after-1" })).toBe(false);
    expect(isPresenterTake({ ...take, audio: { assetId: "ai-take1", sourceStartMs: 0, volume: 1 } })).toBe(false);
  });

  it("picks b-roll from the reel's own footage, same room first, never a take or a 360 photo", () => {
    const timeline = reel(pool, kitchen, take, photo, clip({ id: "ai", assetId: "ai-other", volume: 0 }), clip({ id: "pano", assetId: "sphere", kind: "IMAGE", pano: { yawStart: 0, yawEnd: 90 } as never }));
    expect(brollFor(timeline, 2).map(c => c.id)).toEqual(["k", "ph", "p"]);
    expect(brollWindow(kitchen, 1, 1500)).toEqual({ sourceStartMs: 2000 + Math.round(4500 * 0.382), sourceEndMs: 2000 + Math.round(4500 * 0.382) + 1500 });
    expect(brollWindow(photo, 2, 1500)).toEqual({ sourceStartMs: 0, sourceEndMs: 1500 });
    expect(brollWindow(clip({ id: "s", assetId: "short", sourceEndMs: 1000 }), 1, 1500)).toEqual({ sourceStartMs: 0, sourceEndMs: 1000 });
  });

  it("cuts to b-roll every N seconds of the take with her voice continuing under it (a J-cut), then back to her", () => {
    const timeline = reel(kitchen, take, pool);
    const cut = planCutaways(timeline, { everyMs: 3000 });
    expect(cut.clips.map(c => c.id)).toEqual(["k", "script-ai-take1", "script-ai-take1-cut-1", "script-ai-take1-after-1", "p"]);
    const [, first, broll, after] = cut.clips;
    expect(first).toMatchObject({ assetId: "ai-take1", sourceStartMs: 0, sourceEndMs: 3000, volume: 1 });
    expect(broll).toMatchObject({ assetId: "kitchen", volume: 0, transitionIn: "cut", speed: 1, audio: { assetId: "ai-take1", sourceStartMs: 3000, volume: 1 } });
    expect(clipDurationMs(broll)).toBe(CUTAWAY_HOLD_MS);
    expect(after).toMatchObject({ assetId: "ai-take1", sourceStartMs: 4500, sourceEndMs: 8000, volume: 1, transitionIn: "cut" });
    // The reel is exactly as long as before: the cutaway replaces her picture, not her time.
    expect(timelineDurationMs(cut)).toBe(timelineDurationMs(timeline));
    expect(timelineSchema.safeParse(cut).success).toBe(true);
    expect(cutawaySpacing(cut)).toBe(3000);
    // Every 2 s: two cutaways in an 8 s take (2–3.5, 5.5–7), the last piece at least half a second.
    expect(planCutaways(timeline, { everyMs: 2000 }).clips.map(c => c.id)).toEqual(["k", "script-ai-take1", "script-ai-take1-cut-1", "script-ai-take1-after-1", "script-ai-take1-cut-2", "script-ai-take1-after-2", "p"]);
  });

  it("leaves a take too short for a cutaway whole, and a reel with no b-roll untouched", () => {
    expect(planCutaways(reel(kitchen, { ...take, sourceEndMs: 4000 }), { everyMs: 3000 })).toEqual(reel(kitchen, { ...take, sourceEndMs: 4000 }));
    const alone = reel(take);
    expect(planCutaways(alone, { everyMs: 3000 })).toBe(alone);
    const pair = reel(kitchen, take);
    expect(planCutaways(pair, { everyMs: 1000 })).toBe(pair);
  });

  it("removes and rejoins, so running it again with another spacing replaces the cutaways", () => {
    const timeline = reel(kitchen, take, pool);
    const three = planCutaways(timeline, { everyMs: 3000 });
    expect(removeCutaways(three)).toEqual(timeline);
    const four = planCutaways(three, { everyMs: 4000 });
    expect(four.clips.map(c => c.id)).toEqual(["k", "script-ai-take1", "script-ai-take1-cut-1", "script-ai-take1-after-1", "p"]);
    expect(four.clips[1].sourceEndMs).toBe(4000);
    expect(planCutaways(three, { everyMs: null })).toEqual(timeline);
    expect(planCutaways(three, { everyMs: 3000 })).toEqual(three);
  });

  it("is one command: titles after the take keep their place, and the music ducks under her voice during the cutaway", () => {
    const timeline = reel(kitchen, take, pool);
    const result = applyCommand(timeline, { type: "cutaways", everyMs: 3000 }, { generation: 1 });
    expect(result.rejected).toBeUndefined();
    expect(result.changes.some(change => change.kind === "clip" && change.id === "script-ai-take1-cut-1")).toBe(true);
    expect(result.timeline.texts[0]).toMatchObject({ startMs: 15000, endMs: 17000 });
    const transcripts = { "ai-take1": { text: "", words: [{ w: "one", s: 3200, e: 3600 }, { w: "two", s: 3800, e: 4200 }] } };
    // The take starts at 6 s in the reel; its words at 3.2–4.2 s source play under the cutaway at 9.2–10.2 s reel time.
    const windows = speechWindows(result.timeline, transcripts, { padMs: 0, mergeGapMs: 0 });
    expect(windows).toEqual([{ startMs: 9200, endMs: 9600 }, { startMs: 9800, endMs: 10200 }]);
    expect(applyCommand(result.timeline, { type: "cutaways", everyMs: null }, { generation: 2 }).timeline).toEqual(timeline);
  });
});
