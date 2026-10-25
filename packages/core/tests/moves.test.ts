import { describe, expect, it } from "vitest";
import {
  AI_CAMERA_MOVES, AI_CAMERA_MOVE_RECIPES, AI_DRAFT_COST_CENTS_PER_SECOND, AI_DRAFT_CREDITS, AI_DRAFT_MODEL, AI_VIDEO_MODEL, MOVES, MOVE_GROUPS, MOVE_IDS, MOVE_KEEP_CLAUSE,
  aiClipCostCents, aiClipCredits, aiDefaultClipSeconds, aiDraftCostCents, aiFinalCredits, aiShotPrompt, aiShotSchema, aiVideoResolution, aiOnlyMoves, applyCommand,
  applyMove, cameraKeysAt, cameraSchema, clipDurationMs, isMoveId, moveById, moveCamera, moveLoop, moveOnClip, movePrompt, parseTimeline, realMoves, shiftRoom,
  timelineDurationMs, type Command, type MoveId, type Timeline,
} from "../src";

const reel = (): Timeline => parseTimeline({
  version: 1,
  clips: [
    { id: "a", assetId: "v1", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 4000 },
    { id: "b", assetId: "v2", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 4000 },
    { id: "c", assetId: "p", kind: "IMAGE", sourceStartMs: 0, sourceEndMs: 3000 },
    { id: "d", assetId: "v3", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 4000 },
  ],
  texts: [{ id: "t", text: "Kitchen", startMs: 4200, endMs: 6000, style: "elegant" }],
  music: null,
});
const run = (timeline: Timeline, command: Command) => applyCommand(timeline, command, { generation: 0 });
const clip = (timeline: Timeline, id: string) => timeline.clips.find((item) => item.id === id)!;

describe("the moves table", () => {
  it("has 20 to 30 unique moves, every id listed once", () => {
    expect(MOVES.length).toBeGreaterThanOrEqual(20);
    expect(MOVES.length).toBeLessThanOrEqual(30);
    expect(new Set(MOVES.map((move) => move.id)).size).toBe(MOVES.length);
    expect([...MOVES.map((move) => move.id)].sort()).toEqual([...MOVE_IDS].sort());
    for (const id of MOVE_IDS) expect(isMoveId(id)).toBe(true);
    expect(isMoveId("barrel-roll")).toBe(false);
  });

  it("names the moves the brief asks for", () => {
    for (const id of ["fpv-fly-through", "crash-zoom", "super-dolly-in", "dolly-zoom", "orbit", "reveal-behind", "rise-over-roof", "crane-down", "push-through", "tilt", "parallax-slide", "top-down-spin", "hyperlapse-walk", "pull-back", "slow-push"] as MoveId[]) {
      expect(isMoveId(id)).toBe(true);
    }
    expect(MOVES.some((move) => move.id === "whip-pan-right") && MOVES.some((move) => move.id === "whip-pan-left")).toBe(true);
  });

  it("gives every move a card: label, blurb, group, lens and hands, and a loop", () => {
    for (const move of MOVES) {
      expect(move.label.length).toBeGreaterThan(2);
      expect(move.blurb.length).toBeGreaterThan(10);
      expect(MOVE_GROUPS).toContain(move.group);
      expect(move.ai.lens.length).toBeGreaterThan(2);
      expect(move.ai.hands.length).toBeGreaterThan(10);
      const loop = moveLoop(move.id, 12);
      expect(loop).toHaveLength(13);
      for (const pose of loop) expect(Number.isFinite(pose.scale + pose.x + pose.y + pose.rotate)).toBe(true);
    }
  });

  it("marks exactly the moves with no real side as AI-only, each with its reason and a sketch", () => {
    const aiOnly = aiOnlyMoves().map((move) => move.id);
    expect(aiOnly).toEqual(expect.arrayContaining(["dolly-zoom", "orbit", "top-down-spin", "reveal-behind", "rise-over-roof", "fpv-fly-through", "hyperlapse-walk", "cathedral", "twist"]));
    for (const move of MOVES) {
      if (move.real === null) {
        expect(move.aiOnly?.length).toBeGreaterThan(20);
        expect(move.sketch?.length).toBeGreaterThanOrEqual(2);
      } else {
        expect(move.aiOnly).toBeUndefined();
      }
    }
    expect(realMoves().length + aiOnly.length).toBe(MOVES.length);
    expect(realMoves().length).toBeGreaterThanOrEqual(10);
  });

  it("keeps the AI director's existing camera vocabulary word for word", () => {
    expect([...AI_CAMERA_MOVES]).toEqual(["cathedral", "twist", "tilt", "wide-walk", "pull-back", "detail-orbit", "static"]);
    expect(AI_CAMERA_MOVE_RECIPES.cathedral.prompt).toContain("Ultra-wide lens tilted up toward the ceiling and upper walls");
    expect(AI_CAMERA_MOVE_RECIPES["pull-back"].prompt).toContain("walks slowly backwards away from the subject");
    expect(AI_CAMERA_MOVE_RECIPES.static.prompt).toContain("locked off on a tripod");
    for (const id of AI_CAMERA_MOVES) expect(moveById(id).ai.prompt).toBe(AI_CAMERA_MOVE_RECIPES[id].prompt);
  });
});

describe("Veo prompt templates", () => {
  it.each(MOVES.map((move) => [move.id, move] as const))("%s says what the lens does, keeps one take and leaves the property alone", (id, move) => {
    const prompt = movePrompt(id);
    expect(prompt.length).toBeLessThanOrEqual(1900);
    expect(prompt).toContain(MOVE_KEEP_CLAUSE);
    expect(prompt).toMatch(/no cuts/i);
    if (move.ai.locked) expect(prompt).toMatch(/locked off/i);
    else expect(prompt).toMatch(/smooth gimbal motion/i);
    expect([4, 8]).toContain(move.ai.seconds);
  });

  it("appends the studio's own line last", () => {
    const prompt = movePrompt("crash-zoom", "Zoom onto the fireplace.");
    expect(prompt.endsWith("Zoom onto the fireplace.")).toBe(true);
    expect(prompt).toContain("crash zoom");
  });

  it("replaces the shot's own camera sentence with the move's, once", () => {
    const prompt = aiShotPrompt("gimbal", "A bright kitchen.", { mode: "gimbal", first: { assetId: "p", atMs: 0 }, move: "dolly-zoom" });
    expect(prompt).toContain("vertigo effect");
    expect(prompt).not.toContain("slow stabilized gimbal push");
    expect(prompt).toContain("Start exactly from the supplied first frame");
    expect(prompt).toContain("A bright kitchen.");
    // The Moves sheet fills the box with the whole template; the move is not said twice.
    const filled = aiShotPrompt("gimbal", movePrompt("dolly-zoom"), { mode: "gimbal", first: { assetId: "p", atMs: 0 }, move: "dolly-zoom" });
    expect(filled.split("vertigo effect")).toHaveLength(2);
    // Without a move the prompt is the mode's own.
    expect(aiShotPrompt("gimbal", "", { mode: "gimbal" })).toContain("slow stabilized gimbal push");
  });

  it("accepts a move on a single shot, not on a bridge, and sizes the take from the move", () => {
    expect(aiShotSchema.safeParse({ mode: "custom", move: "orbit" }).success).toBe(true);
    expect(aiShotSchema.safeParse({ mode: "custom", move: "barrel-roll" }).success).toBe(false);
    const frame = { assetId: "p", atMs: 0 };
    expect(aiShotSchema.safeParse({ mode: "bridge", first: frame, last: { assetId: "q", atMs: 0 }, move: "orbit" }).success).toBe(false);
    expect(aiDefaultClipSeconds("custom", "fpv-fly-through")).toBe(8);
    expect(aiDefaultClipSeconds("custom", "orbit")).toBe(4);
    expect(aiDefaultClipSeconds("day-night", "orbit")).toBe(8);
    expect(aiDefaultClipSeconds("custom")).toBe(4);
  });
});

describe("the real side of a move", () => {
  const cameras = MOVES.flatMap((move) => (move.real?.camera ? [[move.id, moveCamera(move.real)!] as const] : []));

  it.each(cameras)("%s is a valid eased move that never exposes the frame's edge", (_id, camera) => {
    expect(cameraSchema.safeParse(camera).success).toBe(true);
    for (let i = 0; i <= 200; i++) {
      const pose = cameraKeysAt(camera, i / 200);
      expect(pose.scale).toBeGreaterThanOrEqual(1);
      expect(pose.scale).toBeLessThanOrEqual(2);
      expect(Math.abs(pose.x)).toBeLessThanOrEqual(shiftRoom(pose.scale) + 1e-9);
      expect(Math.abs(pose.y)).toBeLessThanOrEqual(shiftRoom(pose.scale) + 1e-9);
    }
  });

  it("is deterministic: the same move gives the same keys and the same poses", () => {
    for (const [id, camera] of cameras) {
      const again = moveCamera(moveById(id).real!)!;
      expect(again).toEqual(camera);
      expect(cameraKeysAt(again, 0.37)).toEqual(cameraKeysAt(camera, 0.37));
    }
  });

  it("crash zoom is a fast eased scale: most of the zoom in the first tenth, with a zoom blur on the cut", () => {
    const real = moveById("crash-zoom").real!;
    const camera = moveCamera(real)!;
    const done = cameraKeysAt(camera, 1).scale - 1;
    expect((cameraKeysAt(camera, 0.1).scale - 1) / done).toBeGreaterThan(0.85);
    // Eased: faster at the start than an even move.
    expect((cameraKeysAt(camera, 0.02).scale - 1) / done).toBeGreaterThan(0.3);
    expect(real.cutIn).toMatchObject({ direction: "zoom" });
    expect(real.ramp).toBe("hit");
  });

  it("parallax slide moves sideways across a closer picture and ends where it should", () => {
    const camera = moveCamera(moveById("parallax-slide").real!)!;
    expect(cameraKeysAt(camera, 0).x).toBeLessThan(0);
    expect(cameraKeysAt(camera, 1).x).toBeGreaterThan(0);
    expect(cameraKeysAt(camera, 0.5).x).toBeCloseTo(0, 6);
    expect(cameraKeysAt(camera, 0).scale).toBeGreaterThan(1);
    expect(cameraKeysAt(camera, 0).y).toBe(0);
  });

  it("push through a doorway accelerates to nearly twice the size and ends on a zoom-blurred cut", () => {
    const real = moveById("push-through").real!;
    const camera = moveCamera(real)!;
    const early = cameraKeysAt(camera, 0.5).scale - 1;
    const late = cameraKeysAt(camera, 1).scale - 1;
    expect(early / late).toBeLessThan(0.3);
    expect(cameraKeysAt(camera, 1).scale).toBeGreaterThan(1.9);
    expect(real.ramp).toBe("into-cut");
    expect(real.cutOut).toMatchObject({ direction: "zoom" });
  });

  it("tilt-up and crane-down travel opposite ways", () => {
    const up = moveCamera(moveById("tilt").real!)!;
    const down = moveCamera(moveById("crane-down").real!)!;
    expect(cameraKeysAt(up, 1).y).toBeGreaterThan(cameraKeysAt(up, 0).y);
    expect(cameraKeysAt(down, 1).y).toBeLessThan(cameraKeysAt(down, 0).y);
  });
});

describe("applyMove", () => {
  it("writes a move's camera, ramp and zoom-blurred cut onto a clip, changing no length", () => {
    const before = reel();
    const after = applyMove(before, "b", "crash-zoom");
    const b = clip(after, "b");
    expect(b.camera?.keys[1].scale).toBeGreaterThan(1.6);
    expect(b.ramp?.preset).toBe("hit");
    expect(b.transitionIn).toBe("speedRamp");
    expect(b.speedRamp).toMatchObject({ direction: "zoom", peak: 5 });
    expect(timelineDurationMs(after)).toBe(timelineDurationMs(before));
    expect(after.clips.map(clipDurationMs)).toEqual(before.clips.map(clipDurationMs));
    expect(after.texts).toEqual(before.texts);
    expect(clip(after, "a")).toEqual(clip(before, "a"));
  });

  it("leaves the cut off the first shot, which has none, but still moves the camera", () => {
    const after = applyMove(reel(), "a", "crash-zoom");
    expect(clip(after, "a").camera).not.toBeNull();
    expect(clip(after, "a").transitionIn).toBe("cut");
    expect(() => applyMove(reel(), "a", "whip-pan-right")).toThrow(/first shot has no cut/);
  });

  it("pushes through into the next shot's cut, and skips that on the last shot", () => {
    const after = applyMove(reel(), "b", "push-through");
    expect(clip(after, "c").transitionIn).toBe("speedRamp");
    expect(clip(after, "c").speedRamp?.direction).toBe("zoom");
    expect(clip(after, "b").transitionIn).toBe("cut");
    const last = applyMove(reel(), "d", "push-through");
    expect(clip(last, "d").camera).not.toBeNull();
    expect(last.clips).toHaveLength(4);
  });

  it("skips the speed ramp on a photo, which has no source speed to shape", () => {
    const after = applyMove(reel(), "c", "crash-zoom");
    expect(clip(after, "c").ramp ?? null).toBeNull();
    expect(clip(after, "c").camera).not.toBeNull();
  });

  it("whips follow the direction asked", () => {
    expect(clip(applyMove(reel(), "b", "whip-pan-left"), "b").speedRamp?.direction).toBe("left");
    expect(clip(applyMove(reel(), "b", "whip-pan-right"), "b").speedRamp?.direction).toBe("right");
  });

  it("static clears the eased move and the simple one", () => {
    const moving = applyMove(reel(), "b", "slow-push");
    expect(clip(moving, "b").camera).not.toBeNull();
    const still = applyMove(moving, "b", "static");
    expect(clip(still, "b").camera ?? null).toBeNull();
    expect(clip(still, "b").motion).toBe("none");
  });

  it("is refused for an AI-only move, with the reason, and for a clip or move that is not there", () => {
    expect(() => applyMove(reel(), "b", "dolly-zoom")).toThrow(/AI-only.*perspective/);
    expect(() => applyMove(reel(), "nope", "slow-push")).toThrow(/no clip called nope/);
    expect(() => applyMove(reel(), "b", "barrel-roll" as MoveId)).toThrow(/no camera move called/);
  });

  it("is one command: applied once, the whole move lands; a refusal changes nothing", () => {
    const result = run(reel(), { type: "applyMove", clipId: "b", move: "push-through" });
    expect(result.rejected).toBeUndefined();
    expect(result.changes).toEqual(expect.arrayContaining([{ kind: "clip", id: "b" }, { kind: "clip", id: "c" }]));
    const refused = run(reel(), { type: "applyMove", clipId: "b", move: "orbit" });
    expect(refused.rejected).toMatch(/AI-only/);
    expect(refused.changes).toEqual([]);
    // In a batch it is all or nothing.
    const batch = run(reel(), { type: "batch", commands: [{ type: "applyMove", clipId: "b", move: "slow-push" }, { type: "applyMove", clipId: "c", move: "top-down-spin" }] });
    expect(batch.rejected).toMatch(/AI-only/);
    expect(batch.timeline).toEqual(reel());
  });

  it("marks which move is on a clip", () => {
    const after = applyMove(reel(), "b", "parallax-slide");
    expect(moveOnClip(clip(after, "b"))).toBe("parallax-slide");
    expect(moveOnClip(clip(reel(), "b"))).toBeNull();
    expect(moveOnClip(clip(applyMove(reel(), "b", "tilt"), "b"))).toBe("tilt");
  });
});

describe("draft tier", () => {
  it("uses the cheapest Veo that takes our request and prices the reservation below the full take's", () => {
    expect(AI_DRAFT_MODEL).toBe("veo-3.1-lite-generate-001");
    expect(AI_DRAFT_MODEL).not.toBe(AI_VIDEO_MODEL);
    expect(aiVideoResolution(AI_DRAFT_MODEL)).toBe("720p");
    expect(aiVideoResolution(AI_VIDEO_MODEL)).toBe("1080p");
    for (const seconds of [4, 8] as const) {
      expect(aiDraftCostCents(seconds)).toBe(seconds * AI_DRAFT_COST_CENTS_PER_SECOND);
      expect(aiDraftCostCents(seconds)).toBeLessThan(aiClipCostCents(seconds));
    }
    expect(aiDraftCostCents(4)).toBe(20);
    expect(aiClipCostCents(4)).toBe(40);
  });

  it("charges one credit for a draft and the rest of the full price for the final, never less than one", () => {
    expect(AI_DRAFT_CREDITS).toBe(1);
    // 8 s: a draft costs 1 against 2, and draft + final comes to what the full take cost.
    expect(aiClipCredits(8)).toBe(2);
    expect(AI_DRAFT_CREDITS + aiFinalCredits(8, false, AI_DRAFT_CREDITS)).toBe(aiClipCredits(8));
    // 4 s: the final cannot be free, so a draft here is an extra credit.
    expect(aiFinalCredits(4, false, AI_DRAFT_CREDITS)).toBe(1);
    // Voiced: the voice credit stays on the final.
    expect(aiFinalCredits(4, true, AI_DRAFT_CREDITS)).toBe(1);
    expect(aiFinalCredits(8, true, AI_DRAFT_CREDITS)).toBe(2);
  });

  it("refuses a draft with an ending frame (Lite takes none) and a final that names no draft as a draft", () => {
    const frame = { assetId: "p", atMs: 0 };
    expect(aiShotSchema.safeParse({ mode: "custom", first: frame, last: { assetId: "q", atMs: 0 }, tier: "draft" }).success).toBe(false);
    expect(aiShotSchema.safeParse({ mode: "custom", first: frame, tier: "draft", seed: 123 }).success).toBe(true);
    expect(aiShotSchema.safeParse({ mode: "custom", first: frame, tier: "draft", finalOf: "x" }).success).toBe(false);
    expect(aiShotSchema.safeParse({ mode: "custom", first: frame, tier: "final", finalOf: "x", seed: 4_294_967_295 }).success).toBe(true);
    expect(aiShotSchema.safeParse({ mode: "custom", seed: 4_294_967_296 }).success).toBe(false);
  });
});
