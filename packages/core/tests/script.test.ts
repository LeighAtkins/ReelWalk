import { describe, expect, it } from "vitest";
import { aiClipCredits } from "../src/ai";
import { aiShotSchema } from "../src/ai-shots";
import { applyCommand } from "../src/commands";
import {
  buildScriptShots, composeInstruction, draftScriptLines, insertPresenterTakes, lightFromLuma, lineSeconds, planScript,
  presenterPrompt, presenterTakeClipId, scriptContinuity, scriptQuote, scriptRequestSchema, scriptSlots, DEFAULT_OUTFIT,
  type ScriptRequest,
} from "../src/script";
import { parseTimeline, timelineDurationMs, type Timeline } from "../src/timeline";

// Script mode (ADR 0060): placement, continuity, the quote and placing the takes are pure and tested here; generation is not.

function reel(): Timeline {
  return parseTimeline({
    version: 1,
    clips: [
      { id: "a", assetId: "v1", kind: "VIDEO", sourceStartMs: 2000, sourceEndMs: 6000, room: "entry" },
      { id: "b", assetId: "v2", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 4000, room: "kitchen", filter: "warm" },
      { id: "c", assetId: "v2", kind: "VIDEO", sourceStartMs: 5000, sourceEndMs: 9000, room: "kitchen" },
      { id: "d", assetId: "p1", kind: "IMAGE", sourceStartMs: 0, sourceEndMs: 3000, room: "bedroom" },
      { id: "e", assetId: "v3", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 5000, room: "pool" },
    ],
    texts: [
      // Inside clip b (4–8 s): attached to it.
      { id: "kitchen-title", text: "Chef's kitchen", startMs: 5000, endMs: 7000 },
      // Across several cuts: reel-relative.
      { id: "caption", text: "Just listed", startMs: 1000, endMs: 15000, y: 0.3 },
    ],
    music: null,
  });
}

describe("where each line goes", () => {
  it("offers every cut with the picture on screen there as the plate", () => {
    const slots = scriptSlots(reel());
    expect(slots.map(s => s.boundary)).toEqual([0, 1, 2, 3, 4, 5]);
    // The opening is composed into the first frame of the first clip; every other place into the end of the clip before it.
    expect(slots[0]).toMatchObject({ afterClipId: null, fraction: 0, plate: { assetId: "v1", atMs: 2000 }, plateClipId: "a", room: "entry" });
    expect(slots[2]).toMatchObject({ afterClipId: "b", atMs: 8000, plate: { assetId: "v2", atMs: 3967 }, filter: "warm", roomChange: false });
    expect(slots[1].roomChange).toBe(true);
    expect(slots[3].plate).toEqual({ assetId: "v2", atMs: 8967 });
    expect(slots[4].plate).toEqual({ assetId: "p1", atMs: 0 });
    expect(slots[5]).toMatchObject({ afterClipId: "e", fraction: 1, atMs: timelineDurationMs(reel()) });
  });

  it("never uses a 360 photo or a generated take as a plate", () => {
    const timeline = parseTimeline({ version: 1, clips: [
      { id: "pano", assetId: "pano1", kind: "IMAGE", sourceStartMs: 0, sourceEndMs: 5000, pano: { yawStart: 0, yawEnd: 90 } },
      { id: "take", assetId: "ai-123", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 4000 },
      { id: "real", assetId: "v1", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 4000 },
    ], texts: [], music: null });
    const slots = scriptSlots(timeline);
    // Before the pano (opening) and between the pano and the take have no usable picture either side.
    expect(slots.map(s => [s.boundary, s.plate.assetId])).toEqual([[2, "v1"], [3, "v1"]]);
  });

  it("opens, closes, and puts the middle lines at even shares of the reel, preferring a change of room", () => {
    const slots = scriptSlots(reel());
    expect(planScript(slots, 2).map(s => s.boundary)).toEqual([0, 5]);
    // Total 19 s; half way is 9.5 s. The b|c cut (8 s) is nearer but stays in the kitchen; c|d (12 s) changes room.
    expect(planScript(slots, 3).map(s => s.boundary)).toEqual([0, 3, 5]);
    const four = planScript(slots, 4).map(s => s.boundary);
    expect(four[0]).toBe(0); expect(four[3]).toBe(5);
    expect(four[1]).toBeLessThan(four[2]);
    expect(planScript(slots, 1).map(s => s.boundary)).toEqual([0]);
    expect(planScript([], 3)).toEqual([]);
  });

  it("puts lines back to back when the reel has too few places", () => {
    const one = parseTimeline({ version: 1, clips: [{ id: "a", assetId: "v1", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 4000 }], texts: [], music: null });
    const plan = planScript(scriptSlots(one), 4).map(s => s.boundary);
    expect(plan).toEqual([0, 0, 0, 1]);
    expect(scriptContinuity(plan.map(boundary => ({ boundary })))).toEqual([
      { walksIn: false, walksOut: true }, { walksIn: true, walksOut: true }, { walksIn: true, walksOut: false }, { walksIn: false, walksOut: false },
    ]);
  });
});

describe("the quote", () => {
  it("gives a short line four seconds and a long one eight, every take voiced", () => {
    expect(lineSeconds("Welcome to Ocean House.")).toBe(4);
    expect(lineSeconds("Come with me and let me show you the kitchen first.")).toBe(8);
    const quote = scriptQuote(["Welcome to Ocean House.", "Come with me and let me show you the kitchen first."]);
    expect(quote.seconds).toEqual([4, 8]);
    expect(quote.credits).toEqual([aiClipCredits(4, true), aiClipCredits(8, true)]);
    expect(quote.total).toBe(2 + 3);
  });
});

const script = (overrides: Partial<ScriptRequest> = {}): ScriptRequest => {
  const slots = planScript(scriptSlots(reel()), 3);
  return scriptRequestSchema.parse({
    scriptId: "8c7d4c2e-6a1f-4b7e-9d3a-1e2f3a4b5c6d", presenterId: "kit1", outfit: "a cream linen blazer over a white tee, light jeans",
    takes: [
      { line: "Welcome to Ocean House.", boundary: slots[0].boundary, afterClipId: slots[0].afterClipId, fraction: slots[0].fraction, plate: slots[0].plate, room: "entry", light: "left" },
      { line: "This bedroom wakes up to the water every single morning.", boundary: slots[1].boundary, afterClipId: slots[1].afterClipId, fraction: slots[1].fraction, plate: slots[1].plate, room: "bedroom", light: "behind" },
      { line: "Message me for a private tour.", boundary: slots[2].boundary, afterClipId: slots[2].afterClipId, fraction: slots[2].fraction, plate: slots[2].plate, room: "pool", light: null },
    ],
    ...overrides,
  });
};

describe("continuity in every prompt", () => {
  it("dresses her in the same outfit, word for word, in every composed still and every Veo prompt", () => {
    const shots = buildScriptShots(script(), "reel1");
    const sentence = "She wears a cream linen blazer over a white tee, light jeans: the same clothes, hair and accessories in every shot.";
    for (const shot of shots) {
      expect(shot.shot.compose.first).toContain(sentence);
      expect(shot.prompt).toContain(sentence);
    }
    expect(buildScriptShots(script({ outfit: undefined }), "reel1")[0].shot.compose.first).toContain(DEFAULT_OUTFIT);
  });

  it("lights her from the side the plate's light comes from", () => {
    const [left, behind, even] = buildScriptShots(script(), "reel1");
    expect(left.shot.compose.first).toContain("key light comes from the left of the frame");
    expect(left.prompt).toContain("key light comes from the left of the frame");
    expect(behind.shot.compose.first).toContain("behind her (a bright window)");
    expect(even.shot.compose.first).toContain("the same direction, softness and colour temperature");
  });

  it("stays within the composed still's 600 characters at the longest room, outfit and light, without cutting a sentence", () => {
    const longest = { room: "r".repeat(40), light: "left" as const };
    for (const walksIn of [true, false]) {
      const text = composeInstruction(longest, "o".repeat(120), { walksIn, walksOut: true });
      expect(text.length).toBeLessThanOrEqual(600);
      expect(text.endsWith("furniture's.")).toBe(true);
    }
  });

  it("walks her in from where the last take ended when two are back to back", () => {
    const take = { room: "kitchen", light: null };
    expect(composeInstruction(take, null, { walksIn: true, walksOut: false })).toMatch(/^She steps in from the left edge/);
    expect(presenterPrompt(take, null, "veo", { walksIn: true, walksOut: false })).toContain("continuing from the previous shot where she walked out to the right");
    expect(presenterPrompt(take, null, "veo", { walksIn: false, walksOut: true })).toContain("walks out of the frame to the right");
    const plain = presenterPrompt(take, null, "veo", { walksIn: false, walksOut: false });
    expect(plain).not.toContain("walks out"); expect(plain).toContain("already in place");
  });

  it("keeps one voice: Veo's own audio names the accent; lip sync leaves it to the workspace voice", () => {
    const veo = buildScriptShots(script(), "reel1");
    expect(veo.every(s => s.shot.voice === "veo" && s.prompt.includes("same warm Australian voice in every take"))).toBe(true);
    const lipsync = buildScriptShots(script({ voice: "lipsync" }), "reel1");
    expect(lipsync.every(s => s.shot.voice === "lipsync" && !s.prompt.includes("Australian"))).toBe(true);
  });

  it("builds shots the generation path accepts: the kit, medium framing, the plate as the first frame, the line, the script on record", () => {
    const shots = buildScriptShots(script(), "reel1");
    expect(shots.map(s => [s.durationSeconds, s.credits])).toEqual([[4, 2], [8, 3], [4, 2]]);
    shots.forEach((s, index) => {
      const parsed = aiShotSchema.parse(s.shot);
      expect(parsed.compose).toMatchObject({ presenterId: "kit1", framing: "medium" });
      expect(parsed.first).toEqual(script().takes[index].plate);
      expect(parsed.script).toMatchObject({ id: script().scriptId, reelId: "reel1", index, count: 3, outfit: "a cream linen blazer over a white tee, light jeans" });
      expect(s.shot.compose.first!.length).toBeLessThanOrEqual(600);
      // A speaking take must pass the gate's eyes-and-mouth check (ADR 0056 amendment), so the still asks for them.
      expect(s.shot.compose.first).toContain("both eyes and her mouth clearly visible");
      expect(s.shot.compose.first!.endsWith(".")).toBe(true);
      expect(s.prompt.length).toBeLessThan(2000);
    });
  });

  it("refuses lines out of playing order", () => {
    const valid = script();
    const swapped = { ...valid, takes: [valid.takes[2], valid.takes[0]] };
    expect(scriptRequestSchema.safeParse(swapped).success).toBe(false);
  });
});

describe("the plate's light", () => {
  const picture = (fn: (x: number, y: number) => number, width = 12, height = 8) => ({ data: Array.from({ length: width * height }, (_, i) => fn(i % width, Math.floor(i / width))), width, height });
  it("finds the brighter side, a window behind, or even light", () => {
    expect(lightFromLuma(picture(x => 200 - x * 12))).toBe("left");
    expect(lightFromLuma(picture(x => 60 + x * 12))).toBe("right");
    expect(lightFromLuma(picture(x => x >= 4 && x < 8 ? 230 : 90))).toBe("behind");
    expect(lightFromLuma(picture(() => 128))).toBe("even");
    expect(lightFromLuma({ data: [], width: 0, height: 0 })).toBe("even");
  });
});

describe("placing the finished takes", () => {
  const takes = [
    { assetId: "ai-t1", durationMs: 4000, afterClipId: null, fraction: 0, index: 0 },
    { assetId: "ai-t2", durationMs: 8000, afterClipId: "c", fraction: 12 / 19, index: 1 },
    { assetId: "ai-t3", durationMs: 4000, afterClipId: "e", fraction: 1, index: 2 },
  ];
  it("puts each take where its script chose, whole, at its own sound, graded like its plate", () => {
    const next = insertPresenterTakes(reel(), takes);
    expect(next.clips.map(c => c.id)).toEqual(["script-ai-t1", "a", "b", "c", "script-ai-t2", "d", "e", "script-ai-t3"]);
    const opening = next.clips[0];
    expect(opening).toMatchObject({ assetId: "ai-t1", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 4000, speed: 1, volume: 1, transitionIn: "cut", room: "entry" });
    expect(next.clips[4]).toMatchObject({ filter: "none", room: "kitchen" });
  });

  it("is one command: attached titles follow their clip, reel-relative ones keep their seconds; and it is idempotent", () => {
    const before = reel();
    const result = applyCommand(before, { type: "insertPresenterTakes", takes }, { generation: 0 });
    expect(result.rejected).toBeUndefined();
    const title = result.timeline.texts.find(t => t.id === "kitchen-title")!;
    // Clip b now starts 4 s later (after the opening take), and its title moves with it.
    expect([title.startMs, title.endMs]).toEqual([9000, 11000]);
    const caption = result.timeline.texts.find(t => t.id === "caption")!;
    expect([caption.startMs, caption.endMs]).toEqual([1000, 15000]);
    expect(result.changes.filter(c => c.kind === "clip").map(c => c.kind === "clip" && c.id)).toEqual(expect.arrayContaining(["script-ai-t1", "script-ai-t2", "script-ai-t3"]));
    // Placing the same takes again changes nothing (no undo step).
    expect(applyCommand(result.timeline, { type: "insertPresenterTakes", takes }, { generation: 1 }).changes).toEqual([]);
  });

  it("puts a take whose clip was removed at the cut nearest where it was, and keeps back-to-back takes in order", () => {
    const without = { ...reel(), clips: reel().clips.filter(c => c.id !== "c") };
    const next = insertPresenterTakes(without, [
      { assetId: "ai-x2", durationMs: 4000, afterClipId: "c", fraction: 12 / 19, index: 2 },
      { assetId: "ai-x1", durationMs: 4000, afterClipId: "c", fraction: 12 / 19, index: 1 },
    ]);
    // Without c the reel is 15 s and 12 s of it is nearest the b|d cut (8 s) or d|e (11 s): d|e.
    expect(next.clips.map(c => c.id)).toEqual(["a", "b", "d", presenterTakeClipId("ai-x1"), presenterTakeClipId("ai-x2"), "e"]);
  });
});

describe("a draft script without a model", () => {
  it("greets, names the rooms and asks for the tour", () => {
    expect(draftScriptLines(["Kitchen", "Pool"], "Ocean House", 3)).toEqual(["Come with me, let me show you Ocean House.", "Wait until you see the kitchen.", "Message me today for a private tour."]);
    expect(draftScriptLines([], "", 2)).toEqual(["Come with me, let me show you this home.", "Message me today for a private tour."]);
    expect(draftScriptLines(["a", "b"], "x", 9)).toHaveLength(4);
  });
});
